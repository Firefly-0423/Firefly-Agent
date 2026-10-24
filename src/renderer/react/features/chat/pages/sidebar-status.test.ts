import { describe, expect, it } from "vitest";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import { groupByStatus, sessionStatus, sessionsNeedingInput } from "./sidebar-status";

const session = (id: string, updatedAt: number): ChatSessionMeta => ({ id, title: id, identityId: null, createdAt: 0, updatedAt, messageCount: 1, mode: "code" });

describe("sidebar status grouping", () => {
  it("puts a run waiting on the user under needs input, then working, then done", () => {
    expect(sessionStatus("a", new Set(["a"]), new Set(["a"]))).toBe("needs-input");
    expect(sessionStatus("a", new Set(["a"]), new Set())).toBe("working");
    expect(sessionStatus("a", new Set(), new Set())).toBe("done");
  });

  it("orders groups by status and each group by most recent", () => {
    const grouped = groupByStatus([session("old-done", 1), session("run", 2), session("ask", 3), session("new-done", 9), session("run2", 5)],
      new Set(["run", "run2", "ask"]), new Set(["ask"]));
    expect(grouped.map(item => [item.session.id, item.status])).toEqual([
      ["ask", "needs-input"], ["run2", "working"], ["run", "working"], ["new-done", "done"], ["old-done", "done"],
    ]);
  });

  it("treats an open or queued card and a plan under review as needing input, but not an answered card", () => {
    const card = { kind: "ask", id: "x" } as never;
    expect(sessionsNeedingInput({
      open: { interaction: card, busy: false, queued: [] },
      answered: { interaction: card, busy: false, queued: [], resolved: true },
      answeredWithMore: { interaction: card, busy: false, queued: [card], resolved: true },
    }, { planned: { phase: "review" }, running: { phase: "executing" } })).toEqual(["answeredWithMore", "open", "planned"]);
  });
});
