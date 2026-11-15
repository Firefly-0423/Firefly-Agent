import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatMessage, ChatSession, PendingChatMessage } from "../../../../../shared/chat-types";
import type { ComposerAttachment } from "../components/ChatComposer";
import type { PendingClaimResult, ChatStoreApi } from "./chat-page-bridge";
import { createPendingQueueFlow, type PendingQueueFlowHost } from "./pending-queue-flow";

beforeAll(() => {
  if (!globalThis.crypto?.randomUUID) {
    let identity = 0;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => `queue-placeholder-${++identity}` } });
  }
});
const turn = (id = "head"): ChatMessage => ({ id, role: "user", content: `request ${id}`, at: 1 });
const queued = (id: string): PendingChatMessage => ({ id, rawContent: `request ${id}`, visibleContent: `request ${id}`, enqueuedAt: 1 });
const session = (patch: Partial<ChatSession> = {}) => ({ id: "owner", mode: "chat", messages: [], ...patch }) as ChatSession;
const retained = (messages: ChatMessage[] = [turn()]) => session({ messages, pendingDispatch: { messageId: "head", claimedAt: 1 } });
function claimed(fields: Partial<Extract<PendingClaimResult, { claimed: true }>> = {}): Extract<PendingClaimResult, { claimed: true }> {
  return { ok: true, claimed: true, userMessage: turn(), visibleContent: "request head", remainingQueue: [], session: session(), ...fields };
}
function latch<T>() {
  let release!: (value: T) => void;
  const waiting = new Promise<T>(resolve => { release = resolve; });
  return { waiting, release };
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function setup(execute: PendingQueueFlowHost["startRun"] = async () => {}) {
  const disk = {
    get: vi.fn<ChatStoreApi["get"]>(async () => null),
    pendingEnqueue: vi.fn<ChatStoreApi["pendingEnqueue"]>(async () => ({ ok: true, queue: [] })),
    pendingList: vi.fn<ChatStoreApi["pendingList"]>(async () => []),
    pendingClaim: vi.fn<ChatStoreApi["pendingClaim"]>(async () => ({ ok: true, claimed: false })),
    pendingCompleteDispatch: vi.fn<ChatStoreApi["pendingCompleteDispatch"]>(async () => ({ ok: true, cleared: true })),
    pendingRemove: vi.fn<ChatStoreApi["pendingRemove"]>(async () => ({ ok: true })),
    pendingEdit: vi.fn<ChatStoreApi["pendingEdit"]>(async () => ({ ok: true, queue: [] })),
    pendingUnmark: vi.fn<ChatStoreApi["pendingUnmark"]>(async () => ({ ok: true, queue: [] })),
    pendingAdjust: vi.fn<ChatStoreApi["pendingAdjust"]>(async () => ({ ok: true, queue: [] })),
  };
  const blocked = new Set<string>();
  const rendered = new Set<string>();
  const ports = {
    getStore: () => disk as unknown as ChatStoreApi,
    isSessionBusy: (id: string) => blocked.has(id),
    hasRenderedMessage: (id: string, message: string) => rendered.has(`${id}/${message}`),
    replaceProjection: vi.fn(), appendMessages: vi.fn(), prepareImageAttachments: vi.fn(),
    refreshSessions: vi.fn(), startRun: vi.fn(execute), reportError: vi.fn(),
  };
  const flow = createPendingQueueFlow(() => ports);
  return { flow, disk, ports, blocked, rendered,
    enqueue: (id: string, text = "draft") => flow.enqueue("owner", "chat", { id, rawContent: text, visibleContent: text }),
    consume: () => flow.consume("chat", "owner"),
    projectionIds: () => ports.replaceProjection.mock.calls.at(-1)?.[1]?.map((item: PendingChatMessage) => item.id),
  };
}

describe("Pending mutations follow authoritative store replies", () => {
  test("editing preserves raw text, visible text and sticker metadata", async () => {
    const h = setup();
    const update = { rawContent: "Updated queued request [sticker:shy]", visibleContent: "Updated queued request", userSticker: "shy" };
    h.disk.pendingEdit.mockResolvedValueOnce({ ok: true, queue: [queued("tail")] });
    expect(await h.flow.editMessage("owner", "head", update)).toEqual(true);
    expect(h.disk.pendingEdit.mock.calls).toEqual([["owner", "head", update]]);
    expect(h.projectionIds()).toEqual(["tail"]);
    expect(h.ports.reportError).not.toHaveBeenCalled();
  });
  test.each([true, false])("an edit conflict with queue=%s refreshes only an included projection", async withQueue => {
    const h = setup();
    h.disk.pendingEdit.mockResolvedValueOnce({ ok: false, error: withQueue ? "already-claimed" : "write-failed", ...(withQueue ? { queue: [queued("tail")] } : {}) });
    expect(await h.flow.editMessage("owner", "head", { rawContent: "late", visibleContent: "late" })).toEqual(false);
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
    if (withQueue) {
      expect(h.projectionIds()).toEqual(["tail"]);
      expect(h.ports.reportError.mock.calls[0][0]).toContain("already-claimed");
    } else expect(h.ports.replaceProjection).not.toHaveBeenCalled();
  });
  test("withdrawal updates the queue and reports an in-flight refusal", async () => {
    const h = setup();
    h.disk.pendingUnmark.mockResolvedValueOnce({ ok: true, queue: [queued("head")] });
    expect(await h.flow.unmarkMessage("owner", "head")).toBe(true);
    expect(h.disk.pendingUnmark).toHaveBeenCalledWith("owner", "head");
    expect(h.projectionIds()).toEqual(["head"]);
    h.disk.pendingUnmark.mockResolvedValueOnce({ ok: false, error: "already-adjusting", queue: [queued("head")] });
    expect(await h.flow.unmarkMessage("owner", "head")).toBe(false);
    expect(h.projectionIds()).toEqual(["head"]);
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
  });
  test("an accepted adjustment forwards its id and removes the dispatched entry from projection", async () => {
    const h = setup();
    h.disk.pendingAdjust.mockResolvedValueOnce({ ok: true, queue: [queued("tail")] });
    expect(await h.flow.adjustMessage("owner", "head")).toEqual(true);
    expect(h.disk.pendingAdjust.mock.calls).toEqual([["owner", "head"]]);
    expect(h.projectionIds()).toEqual(["tail"]);
    expect(h.ports.reportError).not.toHaveBeenCalled();
  });
  test.each(["no-active-run", "no-safe-next-step", "has-attachments"])("a refused %s adjustment retains the item and gives a useful explanation", async error => {
    const h = setup();
    h.disk.pendingAdjust.mockResolvedValueOnce({ ok: false, error, queue: [queued("head")] });
    expect(await h.flow.adjustMessage("owner", "head")).toEqual(false);
    expect(h.projectionIds()).toEqual(["head"]);
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
    expect(h.ports.reportError.mock.calls[0][0]).toContain(error === "has-attachments" ? "带附件" : "仍保留在队列中");
  });
  test("adjustment transport errors return failure and retain their error detail", async () => {
    const h = setup();
    h.disk.pendingAdjust.mockRejectedValueOnce(new Error("pending transport unavailable"));
    expect(await h.flow.adjustMessage("owner", "head")).toEqual(false);
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
    expect(h.ports.reportError.mock.calls[0][0]).toContain("pending transport unavailable");
  });
  test("both mutation operations explain an unavailable chat store", async () => {
    const h = setup();
    const absent = createPendingQueueFlow(() => ({ ...h.ports, getStore: () => undefined }));
    expect(await absent.editMessage("owner", "head", { rawContent: "edit", visibleContent: "edit" })).toEqual(false);
    expect(await absent.adjustMessage("owner", "head")).toEqual(false);
    expect(h.ports.reportError.mock.calls.map(([message]) => message)).toHaveLength(2);
    for (const [message] of h.ports.reportError.mock.calls) expect(message).toContain("聊天会话服务尚未就绪");
  });
});

describe("Enqueue visibility and retry identities", () => {
  test.each(["rejected reply", "rejected promise"])("a %s reuses the first id until a successful retry clears it", async failure => {
    const h = setup();
    if (failure === "rejected reply") h.disk.pendingEnqueue.mockResolvedValueOnce({ ok: false, error: "write-failed" });
    else h.disk.pendingEnqueue.mockRejectedValueOnce(new Error("pending transport unavailable"));
    expect(await h.enqueue("original")).toEqual(false);
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
    expect(await h.enqueue("retry")).toEqual(true);
    expect(h.disk.pendingEnqueue.mock.calls.at(-1)).toEqual(["owner", expect.objectContaining({ id: "original" })]);
    expect(await h.enqueue("fresh")).toEqual(true);
    expect(h.disk.pendingEnqueue.mock.calls.at(-1)).toEqual(["owner", expect.objectContaining({ id: "fresh" })]);
  });
  test("incomplete attachments reject the entire draft before IPC", async () => {
    const h = setup();
    const attachment = { kind: "image", name: "incomplete-image.png", filePath: undefined } as unknown as ComposerAttachment;
    expect(await h.flow.enqueue("owner", "chat", { id: "broken", rawContent: "draft with attachment", visibleContent: "draft with attachment", attachments: [attachment] })).toEqual(false);
    expect(h.disk.pendingEnqueue).not.toHaveBeenCalled();
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
  });
  test("busy sessions expose their waiting queue immediately", async () => {
    const h = setup(); h.blocked.add("owner");
    h.disk.pendingEnqueue.mockResolvedValueOnce({ ok: true, queue: [queued("new")] });
    expect(await h.enqueue("new")).toEqual(true);
    expect(h.projectionIds()).toEqual(["new"]);
  });
  test("idle enqueue stays invisible through a delayed claim and publishes only the remaining queue", async () => {
    const h = setup(); const gate = latch<PendingClaimResult>();
    h.disk.pendingEnqueue.mockResolvedValueOnce({ ok: true, queue: [queued("new")] });
    h.disk.get.mockResolvedValue(session());
    h.disk.pendingClaim.mockImplementationOnce(() => gate.waiting);
    expect(await h.enqueue("new", "idle draft")).toEqual(true);
    expect(h.disk.pendingEnqueue.mock.calls[0]).toEqual(["owner", expect.objectContaining({ id: "new", rawContent: "idle draft" })]);
    expect(h.ports.replaceProjection).not.toHaveBeenCalled();
    const consuming = h.consume(); await settle();
    expect(h.ports.replaceProjection).not.toHaveBeenCalled();
    gate.release(claimed()); await consuming;
    expect(h.ports.replaceProjection.mock.calls).toEqual([["owner", []]]);
  });
  test("a new claim appends user then assistant and forwards resume and claim anchors", async () => {
    const h = setup(); h.disk.get.mockResolvedValue(session());
    h.disk.pendingClaim.mockResolvedValueOnce(claimed({ remainingQueue: [queued("tail")], resumeFromRunId: "run-old" }));
    await h.consume();
    expect(h.disk.pendingClaim).toHaveBeenCalledWith("owner");
    expect(h.projectionIds()).toEqual(["tail"]);
    expect(h.ports.appendMessages).toHaveBeenCalledTimes(1);
    expect(h.ports.appendMessages.mock.calls[0][1].map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(h.ports.startRun).toHaveBeenCalledTimes(1);
    expect(h.ports.startRun.mock.calls[0][0]).toMatchObject({ sessionId: "owner", userMessageId: "head", claimedPendingMessageId: "head", resumeFromRunId: "run-old" });
    expect(h.ports.refreshSessions).toHaveBeenCalledWith("chat");
  });
});

describe("Recovery dispatch is tied to the claimed user message", () => {
  test("an already-rendered user receives only an assistant placeholder on recovery", async () => {
    const h = setup(); h.disk.get.mockResolvedValue(retained()); h.rendered.add("owner/head");
    await h.consume();
    expect(h.disk.pendingClaim).not.toHaveBeenCalled();
    expect(h.disk.pendingCompleteDispatch).not.toHaveBeenCalled();
    expect(h.ports.appendMessages).toHaveBeenCalledTimes(1);
    expect(h.ports.appendMessages.mock.calls[0][1]).toEqual([expect.objectContaining({ role: "assistant" })]);
    expect(h.ports.startRun.mock.calls).toEqual([[expect.objectContaining({ sessionId: "owner", userMessageId: "head", claimedPendingMessageId: "head" })]]);
  });
  test.each([true, false])("a terminal answer with matching anchor=%s chooses ledger completion or redispatch", async matches => {
    const h = setup();
    h.disk.get.mockResolvedValueOnce(retained([turn(), { id: "answer", role: "model", content: "completed review", at: 2, answersUserMessageId: matches ? "head" : "older-turn", runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: 2 } }])).mockResolvedValue(session());
    await h.consume();
    if (matches) {
      expect(h.disk.pendingCompleteDispatch).toHaveBeenCalledWith("owner", "head");
      expect(h.disk.pendingClaim).toHaveBeenCalledWith("owner");
      expect(h.ports.startRun).not.toHaveBeenCalled();
    } else {
      expect(h.disk.pendingCompleteDispatch).not.toHaveBeenCalled();
      expect(h.ports.startRun.mock.calls).toEqual([[expect.objectContaining({ userMessageId: "head", claimedPendingMessageId: "head" })]]);
    }
  });
  test("a missing user pauses only the damaged session and never clears or claims its ledger", async () => {
    const h = setup(); h.disk.get.mockResolvedValue(retained([]));
    await h.consume();
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
    expect(h.disk.pendingCompleteDispatch).not.toHaveBeenCalled();
    expect(h.disk.pendingClaim).not.toHaveBeenCalled();
    expect(h.ports.startRun).not.toHaveBeenCalled();
    h.disk.get.mockClear(); await h.consume();
    expect(h.disk.get).not.toHaveBeenCalled();
    h.disk.get.mockResolvedValueOnce(session({ id: "neighbour" }));
    await h.flow.consume("chat", "neighbour");
    expect(h.disk.get).toHaveBeenCalledWith("neighbour");
  });
  test("a claim write failure refreshes the projection and remains retryable", async () => {
    const h = setup(); h.disk.get.mockResolvedValue(session());
    h.disk.pendingClaim.mockResolvedValueOnce({ ok: false, error: "write-failed" });
    await h.consume();
    expect(h.ports.startRun).not.toHaveBeenCalled();
    expect(h.disk.pendingList).toHaveBeenCalledWith("owner");
    expect(h.ports.replaceProjection.mock.calls).toEqual([["owner", []]]);
    h.disk.pendingClaim.mockResolvedValueOnce(claimed()); await h.consume();
    expect(h.ports.startRun).toHaveBeenCalledTimes(1);
  });
  test("deleted, busy, empty and externally claimed sessions never launch work", async () => {
    const h = setup(); await h.consume();
    expect(h.ports.replaceProjection.mock.calls.at(-1)).toEqual(["owner", null]);
    h.disk.get.mockClear(); h.blocked.add("owner"); await h.consume();
    expect(h.disk.get).not.toHaveBeenCalled(); h.blocked.clear();
    h.disk.get.mockResolvedValue(session());
    for (const reply of [{ ok: true, claimed: false }, { ok: false, error: "already-dispatching" }]) {
      h.disk.pendingClaim.mockResolvedValueOnce(reply as PendingClaimResult); await h.consume();
      expect(h.ports.startRun).not.toHaveBeenCalled();
    }
  });
  test("restored images are prepared and dispatched with pending attachment status", async () => {
    const h = setup(); h.disk.get.mockResolvedValue(session());
    h.disk.pendingClaim.mockResolvedValueOnce(claimed({ userMessage: { ...turn("image-turn"), attachments: [{ kind: "image", name: "screen-capture.png", filePath: "C:/review/screen-capture.png", mime: "image/png", status: "pending" }] } }));
    await h.consume();
    expect(h.ports.prepareImageAttachments).toHaveBeenCalledTimes(1);
    expect(h.ports.prepareImageAttachments.mock.calls[0]).toEqual(["owner", "image-turn", [expect.objectContaining({ kind: "image", filePath: "C:/review/screen-capture.png", status: "pending" })]]);
    expect(h.ports.startRun.mock.calls[0][0]).toMatchObject({ userMessageId: "image-turn", claimedPendingMessageId: "image-turn", attachments: [expect.objectContaining({ kind: "image", status: "pending" })] });
  });
});

describe("Concurrent entry points serialize one session", () => {
  test("two recovery consumers share a single read and dispatch", async () => {
    const h = setup(); h.disk.get.mockResolvedValue(retained());
    await Promise.all([h.consume(), h.consume()]);
    expect(h.disk.get).toHaveBeenCalledTimes(1);
    expect(h.ports.startRun.mock.calls).toEqual([[expect.objectContaining({ sessionId: "owner", userMessageId: "head" })]]);
  });
  test("enqueue during an empty initial read schedules exactly one later dispatch", async () => {
    const h = setup(); const read = latch<ChatSession>();
    h.disk.get.mockImplementationOnce(() => read.waiting).mockResolvedValue(session());
    h.disk.pendingClaim.mockResolvedValueOnce({ ok: true, claimed: false }).mockResolvedValueOnce(claimed());
    const first = h.flow.consume("work", "owner");
    expect(await h.flow.enqueue("owner", "work", { id: "head", rawContent: "read the public note", visibleContent: "read the public note" })).toEqual(true);
    await h.flow.consume("work", "owner"); read.release(session()); await first; await settle();
    expect(h.disk.pendingClaim).toHaveBeenCalledTimes(2);
    expect(h.ports.startRun.mock.calls).toEqual([[expect.objectContaining({ sessionId: "owner", userMessageId: "head" })]]);
  });
  test("a finish signal waits for the current run then dispatches its successor once", async () => {
    const gate = latch<void>(); const h = setup(async input => { if (input.userMessageId === "head") await gate.waiting; });
    h.disk.get.mockResolvedValue(session());
    h.disk.pendingClaim.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(claimed({ userMessage: turn("second"), visibleContent: "second request" }));
    const first = h.consume(); await settle(); await h.consume();
    expect(h.ports.startRun.mock.calls.map(([input]) => input.userMessageId)).toEqual(["head"]);
    h.flow.handleRunFinished({ mode: "chat", sessionId: "owner", queuePaused: false });
    gate.release(); await first; await settle();
    expect(h.ports.startRun.mock.calls.map(([input]) => input.userMessageId)).toEqual(["head", "second"]);
    expect(h.disk.pendingClaim).toHaveBeenCalledTimes(2);
  });
  test("a refused run discards pending consumption requests instead of retrying its retained claim", async () => {
    const gate = latch<void>(); const h = setup(async () => gate.waiting);
    h.disk.get.mockResolvedValue(retained());
    const first = h.consume(); await settle(); await h.consume(); await h.enqueue("second", "successor request");
    h.flow.handleRunFinished({ mode: "chat", sessionId: "owner", queuePaused: true });
    gate.release(); await first; await settle();
    expect(h.ports.startRun).toHaveBeenCalledTimes(1);
    expect(h.disk.get).toHaveBeenCalledTimes(1);
  });
  test("paused completion refreshes queue and session list; normal completion also consumes", async () => {
    const h = setup();
    h.flow.handleRunFinished({ mode: "chat", sessionId: "owner", queuePaused: true }); await settle();
    expect(h.disk.pendingList).toHaveBeenCalledWith("owner");
    expect(h.disk.get).not.toHaveBeenCalled();
    expect(h.disk.pendingClaim).not.toHaveBeenCalled();
    expect(h.ports.refreshSessions).toHaveBeenCalledWith("chat");
    h.disk.get.mockResolvedValueOnce(session());
    h.flow.handleRunFinished({ mode: "chat", sessionId: "owner", queuePaused: false }); await settle();
    expect(h.disk.pendingClaim).toHaveBeenCalledWith("owner");
  });
});

describe("queue consumption after run settlement (ChatPage B6/B7)", () => {
  const TERMINAL_STATUSES = ["success", "cancelled", "timeout", "runtime_error"] as const;

  afterEach(() => {
    vi.useRealTimers();
  });

  const flushTimersAndMicrotasks = async () => {
    await vi.runAllTimersAsync();
  };

  function setupTwoSessions(execute: PendingQueueFlowHost["startRun"] = async () => {}) {
    const h = setup(execute);
    const sessions = new Map<string, ChatSession>();
    const queues = new Map<string, PendingChatMessage[]>();
    const dispatches = new Map<string, { messageId: string; claimedAt: number } | undefined>();

    const syncSessionView = (id: string): ChatSession | null => {
      const current = sessions.get(id);
      if (!current) return null;
      return {
        ...current,
        pendingMessages: [...(queues.get(id) ?? [])],
        pendingDispatch: dispatches.get(id),
      };
    };

    h.disk.get.mockImplementation(async (id: string) => syncSessionView(id));
    h.disk.pendingList.mockImplementation(async (id: string) => (queues.has(id) ? [...(queues.get(id) ?? [])] : null));
    h.disk.pendingEnqueue.mockImplementation(async (id: string, entry) => {
      const next = [...(queues.get(id) ?? []), { ...entry, enqueuedAt: Date.now() }];
      queues.set(id, next);
      return { ok: true, queue: [...next] };
    });
    h.disk.pendingCompleteDispatch.mockImplementation(async (id: string, messageId: string) => {
      const active = dispatches.get(id);
      if (active?.messageId !== messageId) return { ok: true, cleared: false };
      dispatches.delete(id);
      return { ok: true, cleared: true };
    });
    h.disk.pendingClaim.mockImplementation(async (id: string) => {
      const queue = queues.get(id) ?? [];
      if (dispatches.get(id)) return { ok: false, error: "already-dispatching" };
      if (queue.length === 0) return { ok: true, claimed: false };
      const [head, ...rest] = queue;
      queues.set(id, rest);
      const userMessage: ChatMessage = { id: head.id, role: "user", content: head.rawContent, at: Date.now() };
      const existing = sessions.get(id);
      if (existing) {
        existing.messages = [...existing.messages, userMessage];
      }
      dispatches.set(id, { messageId: head.id, claimedAt: userMessage.at });
      return {
        ok: true,
        claimed: true,
        userMessage,
        visibleContent: head.visibleContent,
        remainingQueue: [...rest],
        session: syncSessionView(id)!,
      };
    });

    const appendedUserIdsFor = (sessionId: string): string[] =>
      h.ports.appendMessages.mock.calls
        .filter(([sid]) => sid === sessionId)
        .flatMap(([, items]) => items.filter((item: ChatMessageItem) => item.role === "user").map((item: ChatMessageItem) => item.id));

    return { ...h, sessions, queues, dispatches, appendedUserIdsFor };
  }

  test.each(TERMINAL_STATUSES)(
    "consumes the successor once on %s settlement without touching a neighbour session",
    async (terminalStatus) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T14:00:00Z"));
      const h = setupTwoSessions();

      h.sessions.set("session-a", session({ id: "session-a", mode: "chat", messages: [] }));
      h.sessions.set(
        "session-b",
        session({ id: "session-b", mode: "work", messages: [turn("b-init")] }),
      );
      h.queues.set("session-a", [queued("a-1"), queued("a-2")]);
      h.queues.set("session-b", [queued("b-1")]);

      // Start first pending item on session-a
      await h.flow.consume("chat", "session-a");
      expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"]]);
      expect(h.ports.startRun).toHaveBeenCalledTimes(1);
      expect(h.ports.startRun.mock.calls[0][0]).toMatchObject({
        targetMode: "chat",
        sessionId: "session-a",
        userMessageId: "a-1",
        claimedPendingMessageId: "a-1",
      });
      h.rendered.add("session-a/a-1");

      // Session A run ends as accepted with the given terminalStatus (ack cleared pendingDispatch)
      h.dispatches.delete("session-a");
      const sessA = h.sessions.get("session-a")!;
      sessA.messages = [
        ...sessA.messages,
        {
          id: "a-1-reply",
          role: "model",
          content: terminalStatus === "success" ? "Done A1" : "",
          at: Date.now(),
          answersUserMessageId: "a-1",
          runSnapshot: { status: "terminal", terminalStatus, updatedAt: Date.now() },
        },
      ];

      h.flow.handleRunFinished({ mode: "chat", sessionId: "session-a", queuePaused: false });
      await flushTimersAndMicrotasks();

      expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"], ["session-a"]]);
      expect(h.ports.startRun).toHaveBeenCalledTimes(2);
      expect(h.ports.startRun.mock.calls[1][0]).toMatchObject({
        targetMode: "chat",
        sessionId: "session-a",
        userMessageId: "a-2",
        claimedPendingMessageId: "a-2",
      });
      expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1", "a-2"]);
      expect(h.disk.get.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);
      expect(h.appendedUserIdsFor("session-b")).toEqual([]);
      h.rendered.add("session-a/a-2");

      // Session A second run completes: queue is now empty, no extra dispatch and session-b still untouched
      h.dispatches.delete("session-a");
      h.flow.handleRunFinished({ mode: "chat", sessionId: "session-a", queuePaused: false });
      await flushTimersAndMicrotasks();

      expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"], ["session-a"], ["session-a"]]);
      expect(h.ports.startRun).toHaveBeenCalledTimes(2);
      expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1", "a-2"]);
      expect(h.disk.pendingClaim.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);

      // Session B finishes independently and claims/dispatches only its own queued item
      h.flow.handleRunFinished({ mode: "work", sessionId: "session-b", queuePaused: false });
      await flushTimersAndMicrotasks();

      expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"], ["session-a"], ["session-a"], ["session-b"]]);
      expect(h.ports.startRun).toHaveBeenCalledTimes(3);
      expect(h.ports.startRun.mock.calls[2][0]).toMatchObject({
        targetMode: "work",
        sessionId: "session-b",
        userMessageId: "b-1",
        claimedPendingMessageId: "b-1",
      });
      expect(h.appendedUserIdsFor("session-b")).toEqual(["b-1"]);
      expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1", "a-2"]);
    },
  );

  test.each(TERMINAL_STATUSES)(
    "clears retained dispatch ledger on %s settlement and claims the next pending item once",
    async (terminalStatus) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T14:05:00Z"));
      const h = setupTwoSessions();

      h.sessions.set(
        "session-a",
        session({
          id: "session-a",
          mode: "code",
          messages: [
            turn("a-1"),
            {
              id: "a-1-reply",
              role: "model",
              content: terminalStatus === "success" ? "Committed answer" : "",
              at: Date.now(),
              answersUserMessageId: "a-1",
              runSnapshot: { status: "terminal", terminalStatus, updatedAt: Date.now() },
            },
          ],
        }),
      );
      h.dispatches.set("session-a", { messageId: "a-1", claimedAt: Date.now() - 1000 });
      h.queues.set("session-a", [queued("a-2")]);
      h.sessions.set(
        "session-b",
        session({ id: "session-b", mode: "work", messages: [turn("b-init")] }),
      );
      h.queues.set("session-b", [queued("b-1")]);

      h.flow.handleRunFinished({ mode: "code", sessionId: "session-a", queuePaused: false });
      await flushTimersAndMicrotasks();

      expect(h.disk.pendingCompleteDispatch.mock.calls).toEqual([["session-a", "a-1"]]);
      expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"]]);
      expect(h.ports.startRun).toHaveBeenCalledTimes(1);
      expect(h.ports.startRun.mock.calls[0][0]).toMatchObject({
        targetMode: "code",
        sessionId: "session-a",
        userMessageId: "a-2",
        claimedPendingMessageId: "a-2",
      });
      expect(h.appendedUserIdsFor("session-a")).toEqual(["a-2"]);
      expect(h.disk.get.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);
      expect(h.disk.pendingClaim.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);
    },
  );

  test("preserves authoritative claim and queue recovery entry when dispatch is refused, then recovers once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T14:10:00Z"));
    const gate = latch<void>();
    const h = setupTwoSessions(async (input) => {
      if (input.userMessageId === "a-1" && h.ports.startRun.mock.calls.length === 1) {
        await gate.waiting;
      }
    });

    h.sessions.set("session-a", session({ id: "session-a", mode: "chat", messages: [] }));
    h.sessions.set("session-b", session({ id: "session-b", mode: "work", messages: [turn("b-init")] }));
    h.queues.set("session-a", [queued("a-1"), queued("a-2")]);
    h.queues.set("session-b", [queued("b-1")]);

    const firstAttempt = h.flow.consume("chat", "session-a");
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"]]);
    expect(h.ports.startRun).toHaveBeenCalledTimes(1);
    expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1"]);
    h.rendered.add("session-a/a-1");

    // Simulate concurrent consume/enqueue while run a-1 is still in flight, then run refusal -> queuePaused: true
    await h.flow.consume("chat", "session-a");
    h.blocked.add("session-a");
    expect(await h.flow.enqueue("session-a", "chat", { id: "a-3", rawContent: "request a-3", visibleContent: "request a-3" })).toBe(true);
    h.blocked.delete("session-a");
    h.flow.handleRunFinished({ mode: "chat", sessionId: "session-a", queuePaused: true });

    gate.release();
    await firstAttempt;
    await flushTimersAndMicrotasks();

    expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"]]);
    expect(h.disk.pendingCompleteDispatch).not.toHaveBeenCalled();
    expect(h.ports.startRun).toHaveBeenCalledTimes(1);
    expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1"]);
    expect(h.dispatches.get("session-a")).toMatchObject({ messageId: "a-1" });
    expect(h.ports.replaceProjection.mock.calls.at(-1)).toEqual([
      "session-a",
      [expect.objectContaining({ id: "a-2" }), expect.objectContaining({ id: "a-3" })],
    ]);
    expect(h.disk.get.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);

    // Explicit recovery trigger while pendingDispatch a-1 is still unresolved re-dispatches a-1 once without re-claiming or duplicating user message
    await h.flow.consume("chat", "session-a");
    expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"]]);
    expect(h.ports.startRun).toHaveBeenCalledTimes(2);
    expect(h.ports.startRun.mock.calls[1][0]).toMatchObject({
      sessionId: "session-a",
      userMessageId: "a-1",
      claimedPendingMessageId: "a-1",
    });
    expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1"]);
    expect(h.ports.replaceProjection.mock.calls.at(-1)).toEqual([
      "session-a",
      [expect.objectContaining({ id: "a-2" }), expect.objectContaining({ id: "a-3" })],
    ]);

    // After a-1 settles, a normal finish signal claims a-2 exactly once
    h.dispatches.delete("session-a");
    const sessA = h.sessions.get("session-a")!;
    sessA.messages = [
      ...sessA.messages,
      {
        id: "a-1-reply",
        role: "model",
        content: "Recovered answer",
        at: Date.now(),
        answersUserMessageId: "a-1",
        runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: Date.now() },
      },
    ];
    h.flow.handleRunFinished({ mode: "chat", sessionId: "session-a", queuePaused: false });
    await flushTimersAndMicrotasks();

    expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"], ["session-a"]]);
    expect(h.ports.startRun).toHaveBeenCalledTimes(3);
    expect(h.ports.startRun.mock.calls[2][0]).toMatchObject({
      sessionId: "session-a",
      userMessageId: "a-2",
      claimedPendingMessageId: "a-2",
    });
    expect(h.appendedUserIdsFor("session-a")).toEqual(["a-1", "a-2"]);
    expect(h.ports.replaceProjection.mock.calls.at(-1)).toEqual([
      "session-a",
      [expect.objectContaining({ id: "a-3" })],
    ]);
    expect(h.disk.pendingClaim.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);
  });

  test("pauses queue consumption on queuePaused: true while preserving projection, then claims once when resumed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T14:15:00Z"));
    const h = setupTwoSessions();

    h.sessions.set(
      "session-a",
      session({
        id: "session-a",
        mode: "work",
        messages: [
          turn("a-1"),
          {
            id: "a-1-reply",
            role: "model",
            content: "Initial settled answer",
            at: Date.now(),
            answersUserMessageId: "a-1",
            runSnapshot: { status: "terminal", terminalStatus: "success", updatedAt: Date.now() },
          },
        ],
      }),
    );
    h.sessions.set("session-b", session({ id: "session-b", mode: "chat", messages: [] }));
    h.queues.set("session-a", [queued("a-2"), queued("a-3")]);
    h.queues.set("session-b", [queued("b-1")]);

    // Paused finish: refreshes session list and syncs remaining queue projection without claiming or dispatching
    h.flow.handleRunFinished({ mode: "work", sessionId: "session-a", queuePaused: true });
    await flushTimersAndMicrotasks();

    expect(h.ports.refreshSessions).toHaveBeenCalledWith("work");
    expect(h.disk.pendingList.mock.calls).toEqual([["session-a"]]);
    expect(h.ports.replaceProjection.mock.calls).toEqual([
      ["session-a", [expect.objectContaining({ id: "a-2" }), expect.objectContaining({ id: "a-3" })]],
    ]);
    expect(h.disk.get).not.toHaveBeenCalled();
    expect(h.disk.pendingClaim).not.toHaveBeenCalled();
    expect(h.ports.startRun).not.toHaveBeenCalled();
    expect(h.ports.appendMessages).not.toHaveBeenCalled();

    // Subsequent unpaused finish: claims a-2 exactly once, leaves a-3 in queue projection, never touches session-b
    h.flow.handleRunFinished({ mode: "work", sessionId: "session-a", queuePaused: false });
    await flushTimersAndMicrotasks();

    expect(h.disk.pendingClaim.mock.calls).toEqual([["session-a"]]);
    expect(h.ports.startRun).toHaveBeenCalledTimes(1);
    expect(h.ports.startRun.mock.calls[0][0]).toMatchObject({
      targetMode: "work",
      sessionId: "session-a",
      userMessageId: "a-2",
      claimedPendingMessageId: "a-2",
    });
    expect(h.appendedUserIdsFor("session-a")).toEqual(["a-2"]);
    expect(h.ports.replaceProjection.mock.calls.at(-1)).toEqual([
      "session-a",
      [expect.objectContaining({ id: "a-3" })],
    ]);
    expect(h.disk.get.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);
    expect(h.disk.pendingClaim.mock.calls.some(([sid]) => sid === "session-b")).toBe(false);
  });
});
