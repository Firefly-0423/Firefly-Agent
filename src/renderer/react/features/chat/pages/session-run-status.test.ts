import { afterEach, expect, test, vi } from "vitest";
import { isRunStatusCandidate, observeSessionRunStatus, querySessionRunStatus } from "./session-run-status";
import type { RunStatusItem } from "../../../../../shared/run-status";

afterEach(() => vi.useRealTimers());
test.each([[0, []], [511, [511]], [512, [512]], [513, [512, 1]], [1025, [512, 512, 1]]] as const)("queries %i assistant identities in bounded batches without losing order", async (count, sizes) => {
  const candidates = Array.from({ length: count }, (_, index) => ({ assistantTurnId: `a-${index}` }));
  const query = vi.fn(async (request: { sessionId: string; candidates: typeof candidates }) => request.candidates.map(({ assistantTurnId }) => ({ assistantTurnId, phase: "unavailable" as const })));
  expect(await querySessionRunStatus(query, { sessionId: "s", candidates })).toEqual(candidates.map(({ assistantTurnId }) => ({ assistantTurnId, phase: "unavailable" })));
  expect(query.mock.calls.map(([request]) => [request.sessionId, request.candidates.length])).toEqual(sizes.map(size => ["s", size]));
});
const running = (seq: number): RunStatusItem => ({ sessionId: "s", assistantTurnId: "a", runId: "r", seq, phase: "running" });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("registers before querying, ignores older versions and drops responses after disposal", async () => {
  let changed = () => {};
  let resolve!: (items: RunStatusItem[]) => void;
  const publish = vi.fn();
  const query = vi.fn().mockImplementationOnce(() => Promise.resolve([running(4)]))
    .mockImplementationOnce(() => Promise.resolve([running(2)]))
    .mockImplementationOnce(() => new Promise<RunStatusItem[]>(done => { resolve = done; }));
  const off = vi.fn();
  const observer = observeSessionRunStatus({ sessionId: "s", candidates: [{ assistantTurnId: "a" }], query,
    listen: callback => { changed = callback; expect(query).not.toHaveBeenCalled(); return off; }, publish });
  await observer.ready;
  changed(); await tick();
  expect(publish.mock.calls).toEqual([[[running(4)]]]);
  changed(); await tick(); observer.dispose(); resolve([running(9)]); await tick();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(off).toHaveBeenCalledTimes(1);
});

test("polling is bounded, unavailable retains the last known version, and finished stops polling", async () => {
  vi.useFakeTimers();
  const query = vi.fn(async () => [running(1)]);
  const observer = observeSessionRunStatus({ sessionId: "s", candidates: [{ assistantTurnId: "a" }], query,
    listen: () => () => {}, publish: vi.fn() });
  await observer.ready;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(query).toHaveBeenCalledTimes(13);
  observer.dispose();
});

test("rejects mismatched identities and never replaces a terminal version with an unavailable reply", async () => {
  let changed = () => {};
  const finished: RunStatusItem = { ...running(5), phase: "finished", message: { id: "a", role: "model", at: 1, content: "done" } };
  const publish = vi.fn();
  const query = vi.fn().mockResolvedValueOnce([running(1), { ...running(2), sessionId: "other" }])
    .mockResolvedValueOnce([finished]).mockResolvedValueOnce([{ assistantTurnId: "a", phase: "unavailable" }]);
  const observer = observeSessionRunStatus({ sessionId: "s", candidates: [{ assistantTurnId: "a", runId: "r" }], query,
    listen: callback => { changed = callback; return () => {}; }, publish });
  await observer.ready; changed(); await tick(); changed(); await tick();
  expect(publish.mock.calls).toEqual([[[running(1)]], [[finished]]]);
  observer.dispose();
});

test("a failed first query retries without misclassifying interruption", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const query = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([running(1)]);
  const observer = observeSessionRunStatus({ sessionId: "s", candidates: [{ assistantTurnId: "a" }], query,
    listen: () => () => {}, publish });
  await observer.ready;
  expect(publish.mock.calls).toEqual([[[{ assistantTurnId: "a", phase: "unavailable" }]]]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(publish.mock.calls[1]).toEqual([[running(1)]]);
  observer.dispose();
});

test("only unresolved checkpoints, active evidence and empty assistant placeholders need observation", () => {
  const base = { id: "a", role: "model" as const, at: 1, content: "saved answer" };
  expect(isRunStatusCandidate(base)).toBe(false);
  expect(isRunStatusCandidate({ ...base, role: "user", content: "" })).toBe(false);
  expect(isRunStatusCandidate({ ...base, content: "" })).toBe(true);
  expect(isRunStatusCandidate({ ...base, toolExecutions: [{ id: "t", name: "ask_user", status: "running" }] })).toBe(true);
  expect(isRunStatusCandidate({ ...base, runSnapshot: { runId: "r", status: "waiting_user", updatedAt: 1 } })).toBe(true);
  expect(isRunStatusCandidate({ ...base, content: "", runSnapshot: { runId: "r", status: "terminal", terminalStatus: "success", updatedAt: 1 } })).toBe(false);
});
