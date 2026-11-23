import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContextProxy } from "../runtime/context";
import { createRateLimiter } from "./rate-limit";
import { createPluginHostServices, type ServiceDependencies } from "./index";
import { createRpcEndpoint, type PluginRpc } from "../../../shared/plugin-rpc";
import { PLUGIN_TO_HOST_METHODS as P } from "../../../shared/plugin-protocol";

async function callRun(client: PluginRpc, params: unknown) {
  let result;
  for await (const chunk of client.stream<{ type: string; result?: unknown }>(P.modelRun, params)) {
    if (chunk.type === "run.result") result = chunk.result;
  }
  return result;
}
function fixture(confirmationStore = new Map<string, number>()) {
  let grant = { name: "Example", declared: ["model.generate", "model.run", "sessions.read", "workspace.read", "events"], granted: new Set(["model.generate", "model.run", "sessions.read", "workspace.read", "events"]), revision: 1 };
  let context = { sessionId: "current", workspaceRoot: null as string | null, mode: "chat" as const, workspaceName: null as string | null, revision: 1 };
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: unknown) => void>();
  const workspaceListeners = new Set<() => void>();
  const deps: ServiceDependencies = {
    access: () => grant, context: () => context,
    onAccessChange: (_id, fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    confirmations: {
      get: (id, permission) => confirmationStore.get(id + permission),
      set: (id, permission, revision) => { confirmationStore.set(id + permission, revision); },
    },
    confirm: vi.fn(async () => true), currentModel: vi.fn(async () => ({ id: "default" })),
    generateStream: vi.fn(async function* () { yield { delta: "first" }; yield { delta: "second" }; }),
    watchWorkspace: vi.fn((_id, fn) => { workspaceListeners.add(fn); return () => { workspaceListeners.delete(fn); }; }),
    generate: vi.fn(async () => ({ text: "answer", usage: { inputTokens: 1, outputTokens: 2 } })),
    run: vi.fn(async () => ({ runId: "run", sessionId: "current", reply: "reply" })),
    borrowing: vi.fn(() => () => {}),
    sessions: vi.fn(async () => [{ id: "current", mode: "chat", title: "title", createdAt: 1, updatedAt: 2, workspaceRoot: null }]),
    messages: vi.fn(async () => [{ id: "m", role: "user", text: "hello", at: 1 }]),
    redact: vi.fn((text: string) => text.replaceAll("secret-key", "[redacted]")),
    createStreamRedactor: vi.fn(() => ({ push: (text: string) => text.replaceAll("secret-key", "[redacted]"), finish: () => "" })),
    subscribe: vi.fn(fn => { eventListeners.add(fn); return () => { eventListeners.delete(fn); }; }),
  };
  const services = createPluginHostServices(deps);
  let hostReceive: (v: unknown) => void = () => {};
  let pluginReceive: (v: unknown) => void = () => {};
  const host = createRpcEndpoint({ post: f => pluginReceive(f), onFrame: fn => { hostReceive = fn; return () => {}; } });
  const client = createRpcEndpoint({ post: f => hostReceive(f), onFrame: fn => { pluginReceive = fn; return () => {}; } });
  services.configureRpc("dev.test.plugin", host);
  return { deps, services, client, workspaceListeners, workspaceChange: () => { workspaceListeners.forEach(fn => fn()); }, grant, context, eventListeners, changeBinding: () => { listeners.forEach(fn => fn()); }, revoke: () => { grant.revision++; listeners.forEach(fn => fn()); }, emit: (event: unknown) => eventListeners.forEach(fn => fn(event)), close: () => { services.dispose(); client.close(); host.close(); } };
}
afterEach(() => vi.useRealTimers());
describe("model rate limit", () => {
  it("applies live settings changes without resetting prior usage", () => {
    let configured = 1;
    const consume = createRateLimiter(() => configured);
    consume("p"); expect(() => consume("p")).toThrowError(expect.objectContaining({ code: "ERR_RATE_LIMITED" }));
    configured = 60;
    for (let n = 1; n < 60; n++) consume("p");
    expect(() => consume("p")).toThrowError(expect.objectContaining({ code: "ERR_RATE_LIMITED" }));
    configured = 1; expect(() => consume("p")).toThrowError(expect.objectContaining({ code: "ERR_RATE_LIMITED" }));
  });
  it.each([1, 10, 60])("allows exactly %i calls and reopens at 60 seconds", limit => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const consume = createRateLimiter(() => limit);
    for (let n = 0; n < limit; n++) consume("one");
    expect(() => consume("one")).toThrowError(expect.objectContaining({ code: "ERR_RATE_LIMITED", retryable: true }));
    consume("other"); vi.advanceTimersByTime(59_999);
    expect(() => consume("one")).toThrowError(expect.objectContaining({ code: "ERR_RATE_LIMITED" }));
    vi.advanceTimersByTime(1); expect(() => consume("one")).not.toThrow();
  });
});
describe("host services over RPC", () => {
  it("calls every C10 method through the actual SDK proxy and paired RPC endpoints", async () => {
    const f = fixture(), stop = new AbortController();
    const proxy = createPluginContextProxy({ id: "dev.test.plugin", version: "1.2.0", dataDir: "unused", permissions: f.grant.declared, signal: stop.signal, rpc: f.client });
    try {
      const ctx = proxy.ctx;
      expect(await ctx.model.generate({ prompt: "hi", system: "system", maxOutputTokens: 20, schema: { type: "object" } })).toEqual({ text: "answer", usage: { inputTokens: 1, outputTokens: 2 } });
      const chunks = []; for await (const chunk of ctx.model.generateStream({ prompt: "hi" })) chunks.push(chunk);
      expect(chunks).toEqual([{ delta: "first" }, { delta: "second" }]);
      const events = [
        { type: "run.started", runId: "run", sessionId: "current", mode: "chat", at: 1 },
        { type: "text.delta", delta: "secret-key" },
        { type: "tool.started", callId: "call", tool: "read" },
        { type: "tool.completed", callId: "call", tool: "read", status: "succeeded" },
        { type: "run.ended", runId: "run", sessionId: "current", outcome: "completed", at: 2 },
      ] as const;
      vi.mocked(f.deps.run).mockImplementation(async (_req, _profile, _signal, onEvent) => {
        for (const event of events) onEvent({ ...event, privateData: "secret-key" } as any);
        return { runId: "run", sessionId: "current", reply: "secret-key" };
      });
      const run = ctx.model.run({ objective: "work", mode: "chat" });
      const observed = []; for await (const event of run.events) observed.push(event);
      expect(observed).toEqual(events.map(e => e.type === "text.delta" ? { ...e, delta: "[redacted]" } : e));
      expect(await run.result).toEqual({ runId: "run", sessionId: "current", reply: "[redacted]" });
      expect(await ctx.sessions.list()).toEqual({ items: [{ id: "current", mode: "chat", title: "title", updatedAt: 2 }] });
      expect(await ctx.sessions.messages("current")).toEqual({ items: [{ id: "m", role: "user", content: "hello", createdAt: 1 }] });
      expect(await ctx.workspace.current()).toEqual({ sessionId: "current", mode: "chat", root: null, name: null });
      const received: unknown[] = [], workspaces: unknown[] = [];
      const sub = ctx.events.on("run.ended", event => { received.push(event); });
      const watch = ctx.workspace.onChange(info => { workspaces.push(info); });
      await vi.waitFor(() => { expect(f.eventListeners.size).toBe(1); expect(f.workspaceListeners.size).toBe(1); });
      f.emit({ type: "run.started", runId: "ignored", sessionId: "current", mode: "chat", source: "user", at: 1 });
      f.emit({ type: "run.ended", runId: "run", sessionId: "current", outcome: "completed", at: 2, privateData: "secret-key" });
      f.context.sessionId = "new"; f.context.revision++; f.changeBinding(); f.workspaceChange();
      await vi.waitFor(() => {
        expect(received).toEqual([{ type: "run.ended", runId: "run", sessionId: "current", outcome: "completed", at: 2 }]);
        expect(workspaces).toEqual([{ sessionId: "new", mode: "chat", root: null, name: null }]);
      });
      sub.dispose(); watch.dispose();
      await vi.waitFor(() => { expect(f.eventListeners.size).toBe(0); expect(f.workspaceListeners.size).toBe(0); });
    } finally { stop.abort(); proxy.dispose(); f.close(); }
  });
  it.each(["generate", "run"])("redacts credentials split across %s chunks with a per-stream redactor", async kind => {
    const f = fixture(); let buffered = "";
    const finish = vi.fn(() => buffered.replaceAll("secret-key", "[redacted]"));
    vi.mocked(f.deps.createStreamRedactor).mockReturnValue({ push: text => { buffered += text; return ""; }, finish });
    vi.mocked(f.deps.generateStream).mockImplementation(async function* () { yield { delta: "secret-" }; yield { delta: "key" }; });
    vi.mocked(f.deps.run).mockImplementation(async (_req, _profile, _signal, emit) => {
      emit({ type: "text.delta", delta: "secret-" }); emit({ type: "text.delta", delta: "key" });
      return { runId: "run", sessionId: "current", reply: "secret-key" };
    });
    try {
      const chunks = [];
      for await (const chunk of f.client.stream(kind === "generate" ? P.modelGenerate : P.modelRun, kind === "generate" ? { prompt: "hi", stream: true } : { objective: "hi", mode: "chat" })) chunks.push(chunk);
      expect(chunks).toEqual(kind === "generate" ? [{ delta: "[redacted]" }] : [{ type: "text.delta", delta: "[redacted]" }, { type: "run.result", result: { runId: "run", sessionId: "current", reply: "[redacted]" } }]);
      expect(finish).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
  it.each(["generate", "run"])("does not flush the pending redaction suffix when %s is revoked", async kind => {
    const f = fixture(), finish = vi.fn(() => "private tail");
    vi.mocked(f.deps.createStreamRedactor).mockReturnValue({ push: () => "", finish });
    vi.mocked(f.deps.generateStream).mockImplementation(async function* () { yield { delta: "secret-" }; f.grant.granted.delete("model.generate"); f.revoke(); yield { delta: "key" }; });
    vi.mocked(f.deps.run).mockImplementation(async (_req, _profile, _signal, emit) => {
      emit({ type: "text.delta", delta: "secret-" }); f.grant.granted.delete("model.run"); f.revoke();
      return { runId: "run", sessionId: "current", reply: "secret-key" };
    });
    try {
      await expect(f.client.stream(kind === "generate" ? P.modelGenerate : P.modelRun, kind === "generate" ? { prompt: "hi", stream: true } : { objective: "hi", mode: "chat" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "ERR_PERMISSION" });
      expect(finish).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("revoked idle runs settle and hide borrowing when the backend ignores abort", async () => {
    const f = fixture(), hide = vi.fn();
    vi.mocked(f.deps.borrowing).mockReturnValue(hide);
    vi.mocked(f.deps.run).mockImplementation(() => new Promise(() => {}));
    try {
      const next = f.client.stream(P.modelRun, { objective: "hi", mode: "chat" })[Symbol.asyncIterator]().next();
      await vi.waitFor(() => expect(f.deps.run).toHaveBeenCalledTimes(1));
      f.grant.granted.delete("model.run"); f.revoke();
      await expect(next).rejects.toMatchObject({ code: "ERR_PERMISSION" });
      expect(hide).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
  it("rejects a non-boolean stream flag before accessing the model", async () => {
    const f = fixture();
    try {
      await expect(f.client.call(P.modelGenerate, { prompt: "hi", stream: "yes" })).rejects.toMatchObject({ code: "ERR_INVALID_ARGUMENT" });
      expect(f.deps.currentModel).not.toHaveBeenCalled(); expect(f.deps.generateStream).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it.each(["revoke", "rebind", "cancel"])("discards late generate chunks after %s and releases borrowing", async reason => {
    const f = fixture(), abort = new AbortController(), hide = vi.fn(), released = vi.fn();
    let finish!: () => void, providerSignal!: AbortSignal;
    vi.mocked(f.deps.borrowing).mockReturnValue(hide);
    vi.mocked(f.deps.generateStream).mockImplementation(async function* (_request, _profile, signal) {
      providerSignal = signal;
      try { yield { delta: "first" }; await new Promise<void>(resolve => { finish = resolve; }); yield { delta: "private" }; }
      finally { released(); }
    });
    const stream = f.client.stream(P.modelGenerate, { prompt: "hi", stream: true }, { signal: abort.signal })[Symbol.asyncIterator]();
    try {
      expect(await stream.next()).toEqual({ done: false, value: { delta: "first" } });
      const next = stream.next();
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      if (reason === "revoke") { f.grant.granted.delete("model.generate"); f.revoke(); }
      else if (reason === "rebind") { f.context.revision++; f.changeBinding(); }
      else abort.abort();
      await expect(next).rejects.toMatchObject({ code: reason === "revoke" ? "ERR_PERMISSION" : reason === "rebind" ? "ERR_UNAVAILABLE" : "ERR_CANCELLED" });
      expect(providerSignal.aborted).toBe(true);
      await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
      finish(); await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1));
    } finally { f.close(); }
  });
  it.each(["revoke", "rebind", "stop"])("does not publish queued run events or terminal result after %s", async reason => {
    const f = fixture(), hide = vi.fn(); let providerSignal!: AbortSignal, cancel = () => {};
    vi.mocked(f.deps.borrowing).mockImplementation(request => { cancel = request.cancel; return hide; });
    vi.mocked(f.deps.run).mockImplementation(async (_req, _profile, signal, emit) => {
      providerSignal = signal;
      emit({ type: "text.delta", delta: "private" });
      if (reason === "revoke") { f.grant.granted.delete("model.run"); f.revoke(); }
      else if (reason === "rebind") { f.context.revision++; f.changeBinding(); }
      else cancel();
      return { runId: "run", sessionId: "current", reply: "private" };
    });
    try {
      const next = f.client.stream(P.modelRun, { objective: "hi", mode: "chat" })[Symbol.asyncIterator]().next();
      await expect(next).rejects.toMatchObject({ code: reason === "revoke" ? "ERR_PERMISSION" : reason === "rebind" ? "ERR_UNAVAILABLE" : "ERR_CANCELLED" });
      expect(providerSignal.aborted).toBe(true); expect(hide).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
  it("rejects run event overflow without emitting partial or terminal records", async () => {
    const f = fixture();
    vi.mocked(f.deps.run).mockImplementation(async (_req, _profile, _signal, emit) => {
      for (let n = 0; n < 101; n++) emit({ type: "text.delta", delta: "queued" });
      return { runId: "run", sessionId: "current", reply: "late" };
    });
    try { await expect(f.client.stream(P.modelRun, { objective: "hi", mode: "chat" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" }); }
    finally { f.close(); }
  });
  it("rejects foreign-session run events and terminal results", async () => {
    for (const foreignEvent of [true, false]) {
      const f = fixture();
      vi.mocked(f.deps.run).mockImplementation(async (_req, _profile, _signal, emit) => {
        if (foreignEvent) emit({ type: "run.started", runId: "run", sessionId: "foreign", mode: "chat", at: 1 });
        return { runId: "run", sessionId: "foreign", reply: "private" };
      });
      try { await expect(callRun(f.client, { objective: "hi", mode: "chat" })).rejects.toMatchObject({ code: "ERR_PERMISSION" }); }
      finally { f.close(); }
    }
  });
  it("workspace watch survives rebinding, returns null on unbind and rejects revoked queued paths", async () => {
    const f = fixture(); const stream = f.client.stream(P.workspaceWatch, {})[Symbol.asyncIterator]();
    try {
      const next = stream.next(); await vi.waitFor(() => expect(f.workspaceListeners.size).toBe(1));
      f.context.workspaceRoot = "D:/approved"; f.context.workspaceName = "secret-key"; f.context.revision++; f.changeBinding(); f.workspaceChange();
      expect(await next).toEqual({ done: false, value: { sessionId: "current", mode: "chat", root: "D:/approved", name: "[redacted]" } });
      const unbound = stream.next(); vi.spyOn(f.deps, "context").mockReturnValue(null); f.workspaceChange();
      expect(await unbound).toEqual({ done: false, value: null });
      const revoked = stream.next(); f.workspaceChange(); f.grant.granted.delete("workspace.read"); f.revoke();
      await expect(revoked).rejects.toMatchObject({ code: "ERR_PERMISSION" });
      expect(f.workspaceListeners.size).toBe(0);
    } finally { f.close(); }
  });
  it.each([{}, { types: ["run.started"] }, { type: "text.delta" }])("rejects non-contract event subscription %j before subscribing", async params => {
    const f = fixture();
    try {
      await expect(f.client.stream(P.eventsSubscribe, params)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "ERR_INVALID_ARGUMENT" });
      expect(f.deps.subscribe).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("streamed model requests share the same ten-call admission window", async () => {
    const f = fixture();
    try {
      for (let n = 0; n < 5; n++) {
        for await (const _chunk of f.client.stream(P.modelGenerate, { prompt: "hi", stream: true })) {}
        await callRun(f.client, { objective: "hi", mode: "chat" });
      }
      await expect(f.client.call(P.modelGenerate, { prompt: "hi" })).rejects.toMatchObject({ code: "ERR_RATE_LIMITED" });
      expect(f.deps.generateStream).toHaveBeenCalledTimes(5); expect(f.deps.run).toHaveBeenCalledTimes(5); expect(f.deps.generate).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it("does not access the bound conversation when a stream is cancelled before consumption", async () => {
    const f = fixture(); const context = vi.spyOn(f.deps, "context");
    const handlers = new Map<string, Parameters<PluginRpc["handle"]>[1]>();
    const rpc: PluginRpc = { call: vi.fn(), stream: vi.fn(), close: vi.fn(), dispose: vi.fn(),
      handle: (method, handler) => { handlers.set(method, handler); return () => { handlers.delete(method); }; } };
    const dispose = f.services.configureRpc("dev.test.plugin", rpc);
    const abort = new AbortController();
    const iterable = handlers.get(P.eventsSubscribe)!({ type: "run.ended" }, { signal: abort.signal }) as AsyncIterable<unknown>;
    abort.abort(); await iterable[Symbol.asyncIterator]().return?.();
    expect(context).not.toHaveBeenCalled(); expect(f.deps.subscribe).not.toHaveBeenCalled();
    dispose(); f.close();
  });
  it("never reuses a pending workspace confirmation after rebinding", async () => {
    const f = fixture(); let resolve!: (accepted: boolean) => void;
    vi.mocked(f.deps.confirm).mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; })).mockResolvedValue(true);
    const first = f.client.call(P.workspaceInfo, {}).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    f.context.revision++; f.changeBinding();
    const second = f.client.call(P.workspaceInfo, {});
    await Promise.resolve(); await Promise.resolve();
    expect(f.deps.confirm).toHaveBeenCalledTimes(2);
    resolve(true);
    expect(await first).toMatchObject({ code: "ERR_UNAVAILABLE" });
    expect(await second).toEqual({ sessionId: "current", mode: "chat", root: null, name: null }); f.close();
  });
  it("keeps a shared confirmation alive when one waiting request is cancelled", async () => {
    const f = fixture(); let resolve!: (accepted: boolean) => void;
    vi.mocked(f.deps.confirm).mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
    const firstAbort = new AbortController();
    const first = f.client.call(P.sessionsList, {}, { signal: firstAbort.signal }).catch(error => error);
    const second = f.client.call(P.sessionsMessages, { sessionId: "current" });
    await vi.waitFor(() => expect(f.deps.confirm).toHaveBeenCalledTimes(1));
    firstAbort.abort();
    await expect(first).resolves.toMatchObject({ code: "ERR_CANCELLED" });
    resolve(true);
    await expect(second).resolves.toEqual({ items: [{ id: "m", role: "user", content: "hello", createdAt: 1 }] });
    expect(f.deps.confirm).toHaveBeenCalledTimes(1);
    f.close();
  });
  it("allows workspace info and watch to start before a session binding exists", async () => {
    const f = fixture(), context = f.context;
    const contextLookup = vi.spyOn(f.deps, "context").mockReturnValue(null);
    expect(await f.client.call(P.workspaceInfo, {})).toBeNull();
    const stream = f.client.stream(P.workspaceWatch, {})[Symbol.asyncIterator]();
    const next = stream.next();
    await vi.waitFor(() => expect(f.deps.watchWorkspace).toHaveBeenCalledTimes(1));
    contextLookup.mockReturnValue(context);
    f.workspaceChange();
    await expect(next).resolves.toEqual({ done: false, value: { sessionId: "current", mode: "chat", root: null, name: null } });
    await stream.return?.();
    f.close();
  });
  it.each([
    [P.modelGenerate, "model.generate", { prompt: "hi" }],
    [P.modelRun, "model.run", { objective: "hi", mode: "chat" }],
    [P.sessionsList, "sessions.read", {}],
    [P.sessionsMessages, "sessions.read", { sessionId: "current" }],
    [P.workspaceInfo, "workspace.read", {}],
  ])("rejects ungranted %s without underlying calls", async (method, required, params) => {
    const f = fixture(); f.grant.granted.delete(required as string);
    await expect(f.client.call(method as string, params)).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    for (const fn of [f.deps.confirm, f.deps.currentModel, f.deps.generate, f.deps.run, f.deps.sessions, f.deps.messages]) expect(fn).not.toHaveBeenCalled();
    f.close();
  });
  it("returns approved current workspace metadata only", async () => {
    const f = fixture();
    expect(await f.client.call(P.workspaceInfo, {})).toEqual({ sessionId: "current", mode: "chat", root: null, name: null });
    await expect(f.client.call("workspace.read", { path: "file.txt" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    expect(f.deps.confirm).toHaveBeenCalledTimes(1); f.close();
  });
  it("rejects a binding change during first confirmation before reading", async () => {
    const f = fixture(); vi.mocked(f.deps.confirm).mockImplementation(async () => { f.context.revision++; return true; });
    await expect(f.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" });
    expect(f.deps.sessions).not.toHaveBeenCalled(); f.close();
  });
  it("discards data after a revoke while the read is pending", async () => {
    const f = fixture(); vi.mocked(f.deps.messages).mockImplementation(async () => { f.grant.granted.delete("sessions.read"); f.revoke(); return [{ id: "m", role: "user", text: "private", at: 1 }]; });
    await expect(f.client.call(P.sessionsMessages, { sessionId: "current" })).rejects.toMatchObject({ code: "ERR_PERMISSION" }); f.close();
  });
  it("returns deterministic pages and validates limits before data access", async () => {
    const f = fixture(); vi.mocked(f.deps.sessions).mockResolvedValue([1, 2, 3].map(n => ({ id: String(n), mode: "chat", title: String(n), createdAt: n, updatedAt: n, workspaceRoot: null })));
    expect(await f.client.call(P.sessionsList, { limit: 2 })).toEqual({ items: [{ id: "1", mode: "chat", title: "1", updatedAt: 1 }, { id: "2", mode: "chat", title: "2", updatedAt: 2 }], nextCursor: "2" });
    expect(await f.client.call(P.sessionsList, { limit: 2, cursor: "2" })).toEqual({ items: [{ id: "3", mode: "chat", title: "3", updatedAt: 3 }] });
    vi.mocked(f.deps.sessions).mockClear();
    for (const params of [{ limit: 0 }, { limit: 101 }, { cursor: "-1" }, { mode: "system" }, { apiKey: "secret" }]) await expect(f.client.call(P.sessionsList, params)).rejects.toMatchObject({ code: "ERR_INVALID_ARGUMENT" });
    expect(f.deps.sessions).not.toHaveBeenCalled(); f.close();
  });
  it("rejected runs do not consume quota or access the model", async () => {
    const f = fixture(); vi.mocked(f.deps.confirm).mockResolvedValue(false);
    await expect(callRun(f.client, { objective: "hi", mode: "chat" })).rejects.toMatchObject({ code: "ERR_REJECTED" });
    expect(f.deps.currentModel).not.toHaveBeenCalled(); expect(f.deps.run).not.toHaveBeenCalled();
    for (let n = 0; n < 10; n++) await f.client.call(P.modelGenerate, { prompt: "hi" });
    expect(f.deps.generate).toHaveBeenCalledTimes(10); f.close();
  });
  it("model borrowing stop aborts the real operation and always hides its indicator", async () => {
    const f = fixture(); const hide = vi.fn(); let cancel = () => {};
    vi.mocked(f.deps.borrowing).mockImplementation(request => { cancel = request.cancel; return hide; });
    vi.mocked(f.deps.generate).mockImplementation(async (_request, _profile, signal) => {
      cancel(); expect(signal.aborted).toBe(true); return { text: "late" };
    });
    await expect(f.client.call(P.modelGenerate, { prompt: "hi" })).rejects.toMatchObject({ code: "ERR_CANCELLED" });
    expect(hide).toHaveBeenCalledTimes(1); f.close();
  });
  it("revoking events clears queued records and removes the listener", async () => {
    const f = fixture(); const iterator = f.client.stream(P.eventsSubscribe, { type: "run.ended" })[Symbol.asyncIterator]();
    const next = iterator.next(); await Promise.resolve(); await Promise.resolve();
    expect(f.eventListeners.size).toBe(1);
    f.grant.granted.delete("events"); f.revoke();
    await expect(next).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(f.eventListeners.size).toBe(0); f.close();
  });
  it("streams across session switches, excludes other plugins, and projects metadata only", async () => {
    const f = fixture(); const iterator = f.client.stream(P.eventsSubscribe, { type: "run.ended" })[Symbol.asyncIterator]();
    try {
      const next = iterator.next(); await vi.waitFor(() => expect(f.eventListeners.size).toBe(1));
      f.context.sessionId = "next"; f.context.revision++; f.changeBinding();
      f.emit({ type: "run.started", runId: "bad", sessionId: "next", pluginId: "another.plugin.id", mode: "chat", source: "plugin", at: 1 });
      f.emit({ type: "run.ended", runId: "ok", sessionId: "old", workspaceRoot: "D:/private", text: "secret", outcome: "completed", at: 2 });
      expect(await next).toEqual({ done: false, value: { type: "run.ended", runId: "ok", sessionId: "old", outcome: "completed", at: 2 } });
    } finally { f.close(); }
    expect(f.eventListeners.size).toBe(0);
  });
  it("reuses approval across session changes and service restarts, but asks again after a revoke and regrant", async () => {
    const store = new Map<string, number>(), f = fixture(store);
    await f.client.call(P.sessionsList, {});
    f.context.sessionId = "another"; f.context.revision++; f.changeBinding();
    await f.client.call(P.sessionsList, {});
    expect(f.deps.confirm).toHaveBeenCalledTimes(1);
    f.close();
    const reopened = fixture(store);
    try {
      await reopened.client.call(P.sessionsList, {});
      expect(reopened.deps.confirm).not.toHaveBeenCalled();
      reopened.grant.granted.delete("sessions.read"); reopened.revoke();
      await expect(reopened.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_PERMISSION" });
      reopened.grant.granted.add("sessions.read"); reopened.revoke();
      await reopened.client.call(P.sessionsList, {});
      expect(reopened.deps.confirm).toHaveBeenCalledTimes(1);
    } finally { reopened.close(); }
  });
  it("rejects undeclared permission before accessing data", async () => {
    const f = fixture(); f.grant.declared = [];
    await expect(f.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    expect(f.deps.sessions).not.toHaveBeenCalled(); expect(f.deps.confirm).not.toHaveBeenCalled(); f.close();
  });
  it("declined confirmation never reads data", async () => {
    const f = fixture(); vi.mocked(f.deps.confirm).mockResolvedValue(false);
    await expect(f.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_REJECTED" });
    expect(f.deps.sessions).not.toHaveBeenCalled(); f.close();
  });
  it("confirms once and rejects the next read after revocation", async () => {
    const f = fixture(); await f.client.call(P.sessionsList, {}); await f.client.call(P.sessionsList, {});
    expect(f.deps.confirm).toHaveBeenCalledTimes(1);
    f.grant.granted.delete("sessions.read"); f.revoke();
    await expect(f.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(f.deps.sessions).toHaveBeenCalledTimes(2); f.close();
  });
  it("rechecks access after confirmation and before reading", async () => {
    const f = fixture(); vi.mocked(f.deps.confirm).mockImplementation(async () => { f.grant.granted.delete("sessions.read"); f.revoke(); return true; });
    await expect(f.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(f.deps.sessions).not.toHaveBeenCalled(); f.close();
  });
  it("discards data when the bound workspace changes during reading", async () => {
    const f = fixture(); vi.mocked(f.deps.sessions).mockImplementation(async () => { f.context.revision++; return []; });
    await expect(f.client.call(P.sessionsList, {})).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" }); f.close();
  });
  it("returns only scoped DTO fields and redacts content", async () => {
    const f = fixture(); vi.mocked(f.deps.sessions).mockResolvedValue([
      { id: "current", mode: "chat", title: "secret-key", createdAt: 1, updatedAt: 2, workspaceRoot: null, apiKey: "secret-key" } as any,
      { id: "other", mode: "work", title: "other", createdAt: 1, updatedAt: 2, workspaceRoot: "D:/private" },
      { id: "plugin", mode: "work", title: "other plugin", createdAt: 1, updatedAt: 2, workspaceRoot: null, pluginId: "other.plugin.id" },
    ]);
    expect(await f.client.call(P.sessionsList, {})).toEqual({ items: [{ id: "current", mode: "chat", title: "[redacted]", updatedAt: 2 }] });
    vi.mocked(f.deps.messages).mockResolvedValue([{ id: "m", role: "assistant", text: "secret-key", at: 1, secrets: "secret-key" } as any]);
    expect(await f.client.call(P.sessionsMessages, { sessionId: "current" })).toEqual({ items: [{ id: "m", role: "assistant", content: "[redacted]", createdAt: 1 }] });
    await expect(f.client.call(P.sessionsMessages, { sessionId: "other" })).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(f.deps.messages).toHaveBeenCalledTimes(1); f.close();
  });
  it.each(["chat", "work", "code"])("runs %s with source plugin and host-selected model", async mode => {
    const f = fixture(); await callRun(f.client, { objective: "do it", mode });
    expect(f.deps.run).toHaveBeenCalledWith(expect.objectContaining({ source: "plugin", pluginId: "dev.test.plugin", sessionId: "current", mode }), expect.objectContaining({ id: "default" }), expect.any(AbortSignal), expect.any(Function)); f.close();
  });
  it("generate and run share quota, unavailable and rejected calls do not consume it", async () => {
    const f = fixture(); vi.mocked(f.deps.currentModel).mockResolvedValueOnce(null);
    await expect(f.client.call(P.modelGenerate, { prompt: "hi" })).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" });
    for (let n = 0; n < 9; n++) await f.client.call(P.modelGenerate, { prompt: "hi" });
    await callRun(f.client, { objective: "hi", mode: "chat" });
    await expect(f.client.call(P.modelGenerate, { prompt: "hi" })).rejects.toMatchObject({ code: "ERR_RATE_LIMITED", retryable: true });
    expect(f.deps.generate).toHaveBeenCalledTimes(9); f.close();
  });
  it("cancelled event subscription stops pushing and unsubscribes", async () => {
    const f = fixture(); const abort = new AbortController();
    const stream = f.client.stream(P.eventsSubscribe, { type: "run.started" }, { signal: abort.signal })[Symbol.asyncIterator]();
    const next = stream.next(); await Promise.resolve(); await Promise.resolve();
    f.emit({ type: "run.started", runId: "r", sessionId: "current", mode: "chat", source: "user", at: 1, apiKey: "secret-key" });
    expect(await next).toEqual({ done: false, value: { type: "run.started", runId: "r", sessionId: "current", mode: "chat", source: "user", at: 1 } });
    abort.abort(); await expect(stream.next()).rejects.toMatchObject({ code: "ERR_CANCELLED" });
    expect(vi.mocked(f.deps.subscribe).mock.results).toHaveLength(1); f.close();
  });
});
