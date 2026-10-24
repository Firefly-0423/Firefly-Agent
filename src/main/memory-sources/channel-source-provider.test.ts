import { expect, it, vi } from "vitest";
import { contextFixture } from "../../../scripts/verify/memory-context/context-fixture";
import { ChannelManager } from "../channels/manager";
import { createChannelMemoryAccountIdentity, type ChannelAdapter } from "../channels/adapters/base";
import type { IncomingMessage } from "../channels/types";
import { formatChannelUserText } from "../channels/channel-context";
import { markChannelTextTransform, requireChannelMemoryIngress, type ChannelMemoryIngress } from "../memory-context/channel-memory-ingress";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { createMainHistory } from "../memory-history/main-history";
import { createMainUserFactCoordinator } from "../memory-policy/main-user-fact-coordinator";
import { createChannelSourceProvider } from "./channel-source-provider";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: { Channels: "channels" } }));

async function account(accountKey = "qq:account-a") {
  const identity = createChannelMemoryAccountIdentity(); identity.authenticate(accountKey);
  const adapter: ChannelAdapter = { id: "qq", displayName: "synthetic", capability: {} as never, onMessage: null,
    start: async () => {}, stop: async () => {}, send: async () => ({ ok: true }), getMemoryAccountIdentity: identity.read,
    getStatus: () => ({ enabled: true, phase: "running" }) };
  const manager = new ChannelManager(); manager.register(adapter);
  let cap: ChannelMemoryIngress;
  manager.setDispatcher(async (_message, ingress) => { cap = ingress!; return null; }); await manager.startOne("qq");
  const receive = async (patch: Partial<IncomingMessage> = {}, asr = false) => {
    const message: IncomingMessage = { channel: "qq", senderId: "sender", chatId: "chat", text: "I prefer bash", at: new Date(1700000000000), ...patch };
    if (asr) markChannelTextTransform(message, "asr");
    await adapter.onMessage!(message); return { message, cap: cap! };
  };
  return { receive, manager, identity };
}
async function fixture(signal?: AbortSignal) {
  const f = await contextFixture(), store = new ConversationTranscriptStore(f.root);
  const source = createChannelSourceProvider({ providerId: "synthetic", store, clock: () => 1700000000000, signal });
  const a = await account();
  async function bind(event: Awaited<ReturnType<typeof a.receive>>) {
    const context = source.attach(event.cap, event.message), access = f.registry.authority.access(context.scopeKey);
    const identity = { providerId: "synthetic", sessionId: context.sessionId, messageId: "user-1" };
    const actor = f.actorAuthority.bindActor(access, source.token, identity);
    return { ...event, context, access, identity, actor,
      commit: () => source.commitUserEvent(event.cap, { message: event.message, messageId: identity.messageId, text: formatChannelUserText(event.message) }),
      capture: () => f.registry.capture(access, source.token, identity) };
  }
  return { ...f, store, source, a, bind };
}
it("requires a genuine ingress and fresh canonical commit, never historical role labels", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive());
  expect(() => f.source.attach({} as ChannelMemoryIngress, event.message)).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
  await f.store.append(event.context.sessionId, { id: "old", kind: "user", turnId: "user-1", revision: 1, at: 1700000000000, payload: { text: "I prefer bash" } });
  await expect(event.capture()).rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
  await expect(event.commit()).rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
});
it("publishes a direct source only after the exact canonical append is committed", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive());
  await expect(f.source.commitUserEvent(event.cap, { message: event.message, messageId: "user-1", text: "I prefer administrator access" })).rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
  const id = await event.commit(), ref = await event.capture();
  expect(id).toEqual(event.identity);
  expect(f.registry.resolveVerifiedSource(ref)).toMatchObject({ scopeKey: event.context.scopeKey, sourceTrust: "direct-user-event", kind: "user" });
  expect(await f.registry.readEvidence(event.access, f.source.token, ref)).toBe(event.message.text);
  expect((await f.store.read(event.context.sessionId)).entries).toHaveLength(1);
  await expect(event.commit()).rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
});
it("isolates real SQLite memory and history for two accounts, senders and groups", async () => {
  const f = await fixture(), b = await account("qq:account-b");
  const events = [await f.bind(await f.a.receive()), await f.bind(await b.receive()),
    await f.bind(await f.a.receive({ senderId: "someone-else" })), await f.bind(await f.a.receive({ chatType: "group", chatId: "group" }))];
  const history = createMainHistory({ actorAuthority: f.actorAuthority, registry: f.registry,
    transport: { ...f.transport, historyCommand: async command => f.repo.historyCommand(command) } });
  const first = events[0]; await first.commit(); const ref = await first.capture();
  const coordinator = createMainUserFactCoordinator({ actorAuthority: f.actorAuthority, registry: f.registry, policy: f.policy });
  await coordinator.onCommittedUserSource(first.actor, ref);
  await history.captureSource(first.actor, ref, { documentId: "bash-source", incarnation: "v1", revision: 1 });
  expect((await f.policy.recall(first.actor)).map(fact => fact.assertion).join(" ")).toContain("bash");
  expect((await history.query(first.actor, { query: "bash" })).hits).toHaveLength(1);
  for (const other of events.slice(1)) {
    expect(await f.policy.recall(other.actor)).toEqual([]);
    expect((await history.query(other.actor, { query: "bash" })).hits).toEqual([]);
    expect(() => history.grantSessions(other.actor, [first.actor])).toThrow("MEMORY_HISTORY_ACCESS_DENIED");
    await expect(f.registry.readEvidence(other.access, f.source.token, ref)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
  }
});
it.each(["quote", "asr"])("preserves %s provenance without promoting it to user facts", async kind => {
  const f = await fixture(), event = await f.bind(await f.a.receive(kind === "quote" ? { chatType: "group", reply: { messageId: "q", senderId: "other", text: "I prefer powershell" } } : {}, kind === "asr"));
  await event.commit(); const ref = await event.capture();
  expect(f.registry.resolveVerifiedSource(ref).sourceTrust).toBe(kind === "asr" ? "imported" : "history");
  const coordinator = createMainUserFactCoordinator({ actorAuthority: f.actorAuthority, registry: f.registry, policy: f.policy });
  await expect(coordinator.onCommittedUserSource(event.actor, ref)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");
  expect(await f.policy.recall(event.actor)).toEqual([]);
});
it("explicitly denies unmaterialized attachment and source-less fact admission", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive({ attachments: [{ kind: "image", url: "https://example.invalid/not-materialized.png" }] }));
  await expect(event.commit()).rejects.toThrow("MEMORY_CHANNEL_ATTACHMENT_SOURCE_DENIED");
  const empty = await f.bind(await f.a.receive({ text: "" }));
  await expect(empty.commit()).rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
  expect((await f.store.read(event.context.sessionId)).entries).toHaveLength(0);
});
it("invalidates every old source grant at reconnect and never promotes replaced canonical bytes", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive()); await event.commit(); const ref = await event.capture();
  f.a.identity.revoke(); f.a.identity.authenticate("qq:account-a");
  await expect(f.registry.readEvidence(event.access, f.source.token, ref)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
  const fresh = await f.a.receive(); f.source.attach(fresh.cap, fresh.message);
  expect(await f.registry.readEvidence(event.access, f.source.token, ref)).toBe("I prefer bash");
  await f.store.append(event.context.sessionId, { id: "edited", kind: "turn_rewind", turnId: "user-1", revision: 2, at: 1700000000001,
    payload: { anchorUserTurnId: "user-1", disposition: "replace_user", reason: "edit", replacementUser: { text: "I prefer powershell" } } });
  await expect(f.registry.readEvidence(event.access, f.source.token, ref)).rejects.toThrow("MEMORY_SOURCE_DELETED");
});
it("restores only an existing encrypted receipt after provider recreation", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive()); await event.commit(); const ref = await event.capture();
  const restored = createChannelSourceProvider({ providerId: "synthetic", store: f.store }); restored.attach(event.cap, event.message);
  expect(await f.registry.readEvidence(event.access, restored.token, ref)).toBe("I prefer bash");
  const historical = { ...event.identity, messageId: "history-only" };
  await f.store.append(event.context.sessionId, { id: "old-user", kind: "user", turnId: historical.messageId, revision: 1, at: 1700000000000, payload: { text: "I prefer powershell" } });
  await expect(f.registry.capture(event.access, restored.token, historical)).rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
});
it("does not publish an in-flight source when its captured account is revoked", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive()); await event.commit();
  const { createMainSourceRegistry } = await import("./source-registry");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const registry = createMainSourceRegistry({ sourceCommand: async (command: unknown) => {
    const result = await f.transport.sourceCommand(command);
    if ((command as { kind: string }).kind === "finish") { entered(); await held; }
    return result;
  } });
  const access = registry.authority.access(event.context.scopeKey), pending = registry.capture(access, f.source.token, event.identity);
  await ready; f.a.identity.revoke(); f.a.identity.authenticate("qq:account-a");
  const next = await f.a.receive(); f.source.attach(next.cap, next.message); release();
  await expect(pending).rejects.toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
});
it("one authenticated event cannot mint a second direct source under another message identity", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive()); await event.commit();
  await expect(f.source.commitUserEvent(event.cap, { message: event.message, messageId: "second", text: event.message.text }))
    .rejects.toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
});
it("pins the committed text before asynchronous canonical reads", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive());
  const read = f.store.read.bind(f.store); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.store, "read").mockImplementationOnce(async id => { const value = await read(id); entered(); await held; return value; });
  const input = { message: event.message, messageId: "user-1", text: "I prefer bash" };
  const pending = f.source.commitUserEvent(event.cap, input); await ready;
  input.text = "I prefer powershell"; release(); await pending;
  const ref = await event.capture(); expect(await f.registry.readEvidence(event.access, f.source.token, ref)).toBe("I prefer bash");
});

it("commits exact authenticated local attachment references without promoting their text or bytes to M", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive({ text: "", attachments: [
    { kind: "image", filePath: "/downloaded/image.png", mime: "image/png", caption: "chart" },
    { kind: "file", filePath: "/downloaded/reference.txt" },
  ] }));
  await event.commit(); const ref = await event.capture();
  expect(f.registry.resolveVerifiedSource(ref).sourceTrust).toBe("history");
  expect(await f.registry.readEvidence(event.access, f.source.token, ref)).toBe("");
  expect((await f.store.read(event.context.sessionId)).entries[0]).toMatchObject({ kind: "user", payload: { text: "", attachments: [
    { kind: "image", name: "image.png", filePath: "/downloaded/image.png", mime: "image/png", caption: "chart" },
    { kind: "document", name: "reference.txt", filePath: "/downloaded/reference.txt" },
  ] } });
  const coordinator = createMainUserFactCoordinator({ actorAuthority: f.actorAuthority, registry: f.registry, policy: f.policy });
  await expect(coordinator.onCommittedUserSource(event.actor, ref)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");
  const restored = createChannelSourceProvider({ providerId: "synthetic", store: f.store }); restored.attach(event.cap, event.message);
  await expect(f.registry.readEvidence(event.access, restored.token, ref)).rejects.toThrow("MEMORY_SOURCE_DELETED");
});
it.each(["audio", "video"] as const)("explicitly refuses unsupported %s materialization before canonical commit", async kind => {
  const f = await fixture(), event = await f.bind(await f.a.receive({ attachments: [{ kind, filePath: "/downloaded/media.bin" }] }));
  await expect(event.commit()).rejects.toThrow("MEMORY_CHANNEL_ATTACHMENT_SOURCE_DENIED");
  expect((await f.store.read(event.context.sessionId)).entries).toEqual([]);
});


it.each([ ["signal", "read"], ["signal", "commit"], ["close", "read"], ["close", "commit"] ] as const)(
  "revokes %s before a blocked canonical %s resumes and waits for real settlement", async (revoke, stage) => {
  const lifetime = new AbortController(), f = await fixture(lifetime.signal), event = await f.bind(await f.a.receive());
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const read = f.store.read.bind(f.store), append = f.store.append.bind(f.store);
  if (stage === "read") vi.spyOn(f.store, "read").mockImplementationOnce(async id => { arrive(); await held; return read(id); });
  else vi.spyOn(f.store, "append").mockImplementationOnce((id, entry, guard) => append(id, entry, {
    ...guard!, validate: async ticket => { await guard!.validate(ticket); arrive(); await held; },
  }));
  const pending = event.commit(), outcome = pending.then(value => value, error => error);
  let finished = false; void outcome.then(() => { finished = true; });
  let closing: Promise<void> | undefined, closed = false;
  try {
    await arrived;
    if (revoke === "signal") lifetime.abort();
    else closing = f.source.close().then(() => { closed = true; });
    await new Promise<void>(setImmediate);
    expect(finished).toBe(false); expect(closed).toBe(false);
    release(); expect(await outcome).toBeInstanceOf(Error);
    await closing;
    expect((await read(event.context.sessionId)).entries).toEqual([]);
    expect(f.commands).toEqual([]);
    expect(() => f.source.attach(event.cap, event.message)).toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
  } finally { release(); await pending.catch(() => undefined); await closing; }
});

it("captures the owner signal instead of accepting replacement and rejects reads after abort", async () => {
  const f = await fixture(), event = await f.bind(await f.a.receive());
  const lifetime = new AbortController(), substitute = new AbortController();
  const options = { providerId: "synthetic", store: f.store, signal: lifetime.signal };
  const source = createChannelSourceProvider(options); source.attach(event.cap, event.message);
  await source.commitUserEvent(event.cap, { message: event.message, messageId: "user-1", text: event.message.text });
  options.signal = substitute.signal; lifetime.abort();
  expect(() => source.attach(event.cap, event.message)).toThrow("MEMORY_CHANNEL_SOURCE_DENIED");
  await expect(f.registry.capture(event.access, source.token, event.identity)).rejects.toThrow("MEMORY_SOURCE_PROVIDER_DENIED");
  await source.close();
});
