import { expect, test, vi } from "vitest";
import * as sessions from "./openSessionByDeps";

test.each([
  ["chat", "chat"], ["work", "work"], ["code", "code"], ["daily", "work"], ["learn", "work"],
  [undefined, null], ["", null], ["unrecognized-mode", null],
])("persisted mode %s resolves to %s", (stored, expected) => {
  expect(sessions.normalizeSessionMode(stored)).toBe(expected);
});

test.each(["chat", "work", "code", "daily", "learn"])("opening %s selects its normalized mode", async mode => {
  const select = vi.fn(async () => "selected" as const);
  const read = vi.fn(async () => ({ mode }));
  const normalized = mode === "daily" || mode === "learn" ? "work" : mode;
  const outcome = await sessions.openSessionByIdWithDeps({ sessionId: "requested-id", isCurrent: () => true, getSession: read, selectSession: select });
  expect(read.mock.calls).toEqual([["requested-id"]]);
  expect(select.mock.calls).toEqual([["requested-id", normalized]]);
  expect(outcome).toEqual({ status: "opened", mode: normalized });
});
test.each([null, {}, { mode: "unsupported" }])("unavailable metadata %j cannot select a session", async metadata => {
  const select = vi.fn();
  const outcome = await sessions.openSessionByIdWithDeps({ sessionId: "missing-id", isCurrent: () => true, getSession: async () => metadata, selectSession: select });
  expect(outcome).toEqual({ status: "unavailable" });
  expect(select.mock.calls).toEqual([]);
});
test("storage read errors propagate before selection", async () => {
  const select = vi.fn();
  await expect(sessions.openSessionByIdWithDeps({ sessionId: "broken-id", isCurrent: () => true, getSession: async () => { throw Error("session database unavailable"); }, selectSession: select })).rejects.toThrow("session database unavailable");
  expect(select.mock.calls).toEqual([]);
});
test.each([
  { id: "requested-id", outcome: "opened", choose: false, opens: 1 },
  { id: "missing-id", outcome: "unavailable", choose: true, opens: 1 },
  { id: "broken-id", outcome: "throws", choose: true, opens: 1 },
  { id: null, outcome: "opened", choose: true, opens: 0 },
])("bootstrap $outcome with URL $id refreshes using selection=$choose", async row => {
  const order: string[] = [];
  const open = vi.fn(async () => {
    order.push("open");
    if (row.outcome === "throws") throw Error("bootstrap storage failure");
    return row.outcome === "opened" ? { status: "opened" as const, mode: "work" as const } : { status: "unavailable" as const };
  });
  const refresh = vi.fn(async () => { order.push("refresh"); });
  await sessions.bootstrapReactSession({ urlSessionId: row.id, currentMode: "work", openSession: open, refreshSessions: refresh });
  expect(open).toHaveBeenCalledTimes(row.opens);
  if (row.opens) expect(open).toHaveBeenCalledWith(row.id);
  expect(refresh.mock.calls).toEqual([["work", row.choose]]);
  expect(order).toEqual(row.opens ? ["open", "refresh"] : ["refresh"]);
});
