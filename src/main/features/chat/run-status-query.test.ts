import { describe, expect, it, vi } from "vitest";
import { queryRunStatus } from "./run-status-query";
const status = { sessionId: "session", assistantTurnId: "assistant", runId: "run", seq: 1, phase: "running" } as const;
function fixture() {
  const sender = { id: 7, mainFrame: {}, isDestroyed: () => false };
  return { event: { sender, senderFrame: sender.mainFrame }, context: {
    window: { webContents: sender, isDestroyed: () => false }, target: { webContentsId: 7, sessionId: "session", mode: "chat" },
    getSession: vi.fn(() => ({ id: "session", mode: "chat" })), getStatus: vi.fn((_session: string, _assistant: string): typeof status | undefined => status),
  } };
}
const request = { sessionId: "session", candidates: [{ assistantTurnId: "assistant" }, { assistantTurnId: "missing" }] };
describe("trusted batch run status query", () => {
  it("returns ordered exact identities and unavailable for absent or mismatched mappings", () => {
    const f = fixture(); f.context.getStatus.mockImplementation((_s, id) => id === "assistant" ? status : undefined);
    expect(queryRunStatus(f.event as any, request, f.context as any)).toEqual([status, { assistantTurnId: "missing", phase: "unavailable" }]);
    expect(queryRunStatus(f.event as any, { sessionId: "session", candidates: [{ assistantTurnId: "assistant", runId: "wrong" }] }, f.context as any)).toEqual([{ assistantTurnId: "assistant", phase: "unavailable" }]);
  });
  it.each(["frame", "window", "target", "session", "destroyed"])("conceals all identities for invalid %s without reading run status", failure => {
    const f = fixture();
    if (failure === "frame") f.event.senderFrame = {};
    if (failure === "window") f.context.window.webContents = {} as any;
    if (failure === "target") f.context.target.sessionId = "other";
    if (failure === "session") f.context.getSession.mockReturnValue({ id: "session", mode: "work" });
    if (failure === "destroyed") f.event.sender.isDestroyed = () => true;
    expect(queryRunStatus(f.event as any, request, f.context as any)).toEqual(request.candidates.map(c => ({ ...c, phase: "unavailable" })));
    expect(f.context.getStatus).not.toHaveBeenCalled();
  });
  it("reads the session once and shares that immutable batch snapshot with every candidate", () => {
    const f = fixture();
    queryRunStatus(f.event as any, request, f.context as any);
    expect(f.context.getSession).toHaveBeenCalledExactlyOnceWith("session");
    const snapshot = f.context.getSession.mock.results[0].value;
    expect(f.context.getStatus.mock.calls).toEqual([["session", "assistant", snapshot], ["session", "missing", snapshot]]);
  });
  it("rejects malformed and oversized batches before accessing sessions", () => {
    const f = fixture();
    for (const invalid of [null, {}, { ...request, sessionId: "../escape" }, { ...request, candidates: Array(513).fill(request.candidates[0]) }]) expect(queryRunStatus(f.event as any, invalid, f.context as any)).toEqual([]);
    expect(f.context.getSession).not.toHaveBeenCalled();
  });
});
