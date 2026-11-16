import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../../shared/permission-approval";
import { APPROVAL_ARGUMENT_LIMIT, APPROVAL_ARGUMENT_TEXT_LIMIT, createApprovalReview, summarizeApprovalArguments } from "./approval-review";

const request = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "approve-1", toolId: "write_file", toolName: "Write file", toolDescription: "Write a workspace file",
  risk: "fs-write", args: { path: "notes.md" }, runId: "run-a", ...patch,
});

function harness(options: { pending?: ApprovalRequest; owner?: string; title?: string; answered?: boolean } = {}) {
  const deps = {
    getPendingApproval: vi.fn((_id: string) => options.pending),
    findActiveSessionForRun: vi.fn((_runId: string) => options.owner),
    getSessionTitle: vi.fn((_id: string) => options.title),
    answerApproval: vi.fn((_id: string, _allowed: boolean) => options.answered ?? true),
  };
  return { deps, review: createApprovalReview(deps) };
}

describe("toast approval review", () => {
  it.each([
    {
      name: "a pending approval whose run is live in its session shows that session",
      options: { pending: request(), owner: "session-a", title: "Release notes" },
      detail: { state: "pending", approvalId: "approve-1", toolName: "Write file", toolId: "write_file",
        session: { id: "session-a", title: "Release notes" }, args: [{ key: "path", value: "notes.md" }] },
    },
    {
      name: "a partner child's approval names the partner and the parent's session",
      options: { pending: request({ agentId: "reviewer", childRunId: "child-1" }), owner: "session-a" },
      detail: { state: "pending", approvalId: "approve-1", toolName: "Write file", toolId: "write_file", agentId: "reviewer",
        session: { id: "session-a" }, args: [{ key: "path", value: "notes.md" }] },
    },
    {
      name: "a pending approval whose run is no longer live cannot be verified",
      options: { pending: request(), owner: undefined },
      detail: { state: "unverified", approvalId: "approve-1", toolName: "Write file", toolId: "write_file", args: [{ key: "path", value: "notes.md" }] },
    },
    {
      name: "an approval without a run id is shown as runless (display only)",
      options: { pending: request({ runId: undefined }) },
      detail: { state: "runless", approvalId: "approve-1", toolName: "Write file", toolId: "write_file", args: [{ key: "path", value: "notes.md" }] },
    },
    {
      name: "a settled, cancelled or unknown approval has expired",
      options: { pending: undefined },
      detail: { state: "expired", approvalId: "approve-1" },
    },
  ])("$name", ({ options, detail }) => {
    const { deps, review } = harness(options);
    expect(review.inspect("approve-1")).toEqual(detail);
    // Inspecting never settles anything.
    expect(deps.answerApproval).not.toHaveBeenCalled();
  });

  it("looks the run up from the original request, not from any open session", () => {
    const { deps, review } = harness({ pending: request({ runId: "run-a" }), owner: "session-a" });
    review.inspect("approve-1");
    expect(deps.getPendingApproval.mock.calls).toEqual([["approve-1"]]);
    expect(deps.findActiveSessionForRun.mock.calls).toEqual([["run-a"]]);
  });

  it.each([
    { name: "pending", options: { pending: request(), owner: "session-a" }, ok: true, settled: [["approve-1", false]] },
    // Main cannot confirm a run-less approval came from a standalone approval entry, so it is shown but never answered here.
    { name: "runless", options: { pending: request({ runId: "" }) }, ok: false, settled: [] },
    { name: "unverified", options: { pending: request(), owner: undefined }, ok: false, settled: [] },
    { name: "expired", options: { pending: undefined }, ok: false, settled: [] },
  ])("answers a $name approval only when it can be verified", ({ options, ok, settled }) => {
    const { deps, review } = harness(options);
    expect(review.answer("approve-1", false)).toEqual({ ok });
    expect(deps.answerApproval.mock.calls).toEqual(settled);
  });

  it("reports ok:false when the approval settles between the check and the answer", () => {
    const { review } = harness({ pending: request(), owner: "session-a", answered: false });
    expect(review.answer("approve-1", true)).toEqual({ ok: false });
  });

  it("lists at most the argument limit and truncates long values", () => {
    const args: Record<string, unknown> = Object.fromEntries(Array.from({ length: APPROVAL_ARGUMENT_LIMIT + 2 }, (_, index) => [`k${index}`, index]));
    args.k0 = "x".repeat(APPROVAL_ARGUMENT_TEXT_LIMIT + 1);
    const summary = summarizeApprovalArguments(args);
    expect(summary.map(item => item.key)).toEqual(Array.from({ length: APPROVAL_ARGUMENT_LIMIT }, (_, index) => `k${index}`));
    expect(summary[0].value).toEqual(`${"x".repeat(APPROVAL_ARGUMENT_TEXT_LIMIT)}…`);
    expect(summarizeApprovalArguments({ exact: "y".repeat(APPROVAL_ARGUMENT_TEXT_LIMIT), nested: { a: 1 } })).toEqual([
      { key: "exact", value: "y".repeat(APPROVAL_ARGUMENT_TEXT_LIMIT) }, { key: "nested", value: "{\"a\":1}" },
    ]);
  });
});
