// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryEntriesPanel } from "./entries-panel";
import type { FactView } from "../../../shared/memory-contracts";
import type { MemoryPanelAction, MemoryPanelState, MemoryPolicyPanelApi } from "../../../shared/memory-panel-contracts";

function fact(assertion = "我喜欢茶", factId = "fact-1"): FactView {
  return { factId, revision: 2, subjectKey: "preference", assertion, assertionKind: "user-statement",
    time: { validFrom: 1, validTo: null, referenceTime: 1000 }, sourceRef: { sourceId: "source-1", revision: 1 }, recordedAt: 2000, acceptedAt: 2000,
    supersededAt: null, activationReason: "explicitUserConfirmed", policyVersion: "test", provenance: { candidateId: "candidate-1", evidenceId: null, activationSourceRef: { sourceId: "settings-source", revision: 1 } } };
}
function fixture() {
  const root = document.createElement("div"); document.body.append(root);
  const state: MemoryPanelState = { facts: [], candidates: [{ reviewState: "ready", contentHash: "a".repeat(64), candidateId: "candidate-1", revision: 1, attribute: "preference", value: "tea", reason: "needs-review", assertion: "我喜欢茶", sourceRef: { sourceId: "source-1", revision: 1 }, occurredAt: 1000 }],
    backendStatus: { available: true }, coverage: { status: "not-measured", reason: "MEMORY_HISTORY_COVERAGE_NOT_MEASURED", population: null, present: null, missing: null, unknownDenied: null, exactRatio: null, lowerRatio: null, upperRatio: null, reasons: {}, evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: null, ratio: null } } };
  const actions: MemoryPanelAction[] = [];
  const api: MemoryPolicyPanelApi = {
    getState: async () => structuredClone(state),
    applyAction: async (action) => {
      actions.push(action);
      if (action.kind === "confirm") { state.candidates = []; state.facts = [fact()]; return { status: "active" }; }
      if (action.kind === "reject") { state.candidates = []; return { status: "rejected", candidateId: action.id, candidateRevision: 2 }; }
      if (action.kind === "correct") { state.facts = [{ ...fact(action.text), revision: 3 }]; return { status: "active" }; }
      state.facts = []; return { status: "forgotten" };
    },
    auditSource: async (id) => ({ factId: id, revision: 2, status: "eligible", reason: "valid-support", sources: [{ sourceId: "settings-source", revision: 1, kind: "explicitUserConfirmed", validity: "valid", occurredAt: 1000 }] }),
  };
  const seen: Array<MemoryPanelState | null> = [];
  const panel = createMemoryEntriesPanel(root, api, (value) => seen.push(value));
  return { root, state, actions, api, panel, seen };
}
const click = (root: HTMLElement, action: string) => (root.querySelector(`[data-memory-action="${action}"]`) as HTMLButtonElement).click();
beforeEach(() => { document.body.replaceChildren(); });

describe("memory entries panel", () => {
  it.each(["", " \n\t", "safe-looking text"])("keeps reference-only/blank cards rejectable without a confirmation action: %j", async assertion => {
    const f = fixture(); Object.assign(f.state.candidates[0], { assertion, reviewState: assertion.trim() ? "reference-only" : "ready", contentHash: "a".repeat(64) });
    await f.panel.load(); await f.panel.load();
    expect(f.root.textContent).toContain("未提取出可确认内容");
    expect(f.root.textContent).toContain("请在对话中重新说明");
    expect(f.root.textContent).not.toContain("等你确认后才会记住");
    expect(f.root.querySelector('[data-memory-action="confirm"]')).toBeNull();
    click(f.root, "reject"); await vi.waitFor(() => expect(f.actions).toHaveLength(1));
    expect(f.actions[0].kind).toBe("reject");
  });
  it("sends the displayed hash with a ready candidate confirmation", async () => {
    const f = fixture(); Object.assign(f.state.candidates[0], { reviewState: "ready", contentHash: "a".repeat(64) });
    await f.panel.load(); click(f.root, "confirm");
    await vi.waitFor(() => expect(f.actions).toHaveLength(1));
    expect(f.actions[0]).toMatchObject({ contentHash: "a".repeat(64), expectedRevision: 1 });
  });
  it.each([undefined, "invalid"])("never offers confirmation without a valid displayed hash: %s", async contentHash => {
    const f = fixture(); f.state.candidates[0].contentHash = contentHash;
    await f.panel.load(); await f.panel.load();
    expect(f.root.querySelector('[data-memory-action="confirm"]')).toBeNull();
    expect((f.root.querySelector('[data-memory-action="reject"]') as HTMLButtonElement).disabled).toBe(false);
  });
  it("explains an unresolved confirmation without claiming the user edited content", async () => {
    const f = fixture(); Object.assign(f.state.candidates[0], { reviewState: "ready", contentHash: "a".repeat(64) });
    f.api.applyAction = async () => ({ status: "rejected", reason: "MEMORY_POLICY_UNRESOLVED" });
    await f.panel.load(); click(f.root, "confirm");
    await vi.waitFor(() => expect(f.root.textContent).toContain("请在对话中重新说明"));
    expect(f.root.textContent).not.toContain("修改后的内容");
  });
  it("lists remembered facts and pending candidates with their kind and status, without internal ids or old product wording", async () => {
    const f = fixture(); f.state.facts = [fact()]; await f.panel.load();
    expect(f.root.textContent).toContain("我喜欢茶");
    expect(f.root.textContent).toContain("你说过");
    expect(f.root.textContent).toContain("待确认");
    expect(f.root.textContent).toContain("记录于");
    expect(f.root.textContent).not.toContain("source-1");
    expect(f.root.textContent).not.toMatch(/L0|L1|无历史|SMH|覆盖|证据资格/);
  });
  it("shows where each fact applies when the policy reports it, and nothing when it does not", async () => {
    const f = fixture(); f.state.facts = [{ ...fact("我默认用 bash", "fact-p"), scope: "project" }, { ...fact("请叫我小林", "fact-g"), scope: "global" }, fact("无范围信息", "fact-n")]; await f.panel.load();
    const text = (assertion: string) => [...f.root.querySelectorAll("article")].find((node) => node.textContent?.includes(assertion))!.textContent!;
    expect(text("我默认用 bash")).toContain("仅限某个项目");
    expect(text("请叫我小林")).toContain("所有会话");
    expect(text("无范围信息")).not.toMatch(/所有会话|仅限某个项目/);
  });
  it("names the project of a project fact or candidate and shows when a fact takes effect", async () => {
    const f = fixture();
    f.state.facts = [{ ...fact("我默认用 bash", "fact-p"), scope: "project", projectName: "alpha", time: { validFrom: 5000, validTo: 9000, referenceTime: 1000 } }];
    f.state.candidates = [{ ...f.state.candidates[0], assertion: "我可能喜欢 zsh", scope: "project", projectName: "beta" }, { ...f.state.candidates[0], candidateId: "candidate-2", assertion: "我可能喜欢咖啡", scope: "global" }];
    await f.panel.load();
    const text = (assertion: string) => [...f.root.querySelectorAll("article")].find((node) => node.textContent?.includes(assertion))!.textContent!;
    expect(text("我默认用 bash")).toContain("仅限项目「alpha」");
    expect(text("我默认用 bash")).toContain("生效于"); expect(text("我默认用 bash")).toContain("有效至");
    expect(text("我可能喜欢 zsh")).toContain("仅限项目「beta」");
    expect(text("我可能喜欢咖啡")).toContain("所有会话");
  });
  it("filters by type and searches loaded text locally", async () => {
    const f = fixture(); f.state.facts = [fact("我住在上海")]; await f.panel.load();
    const filter = (value: string) => (f.root.querySelector(`[data-memory-filter="${value}"]`) as HTMLButtonElement).click();
    filter("facts");
    expect(f.root.textContent).toContain("我住在上海"); expect(f.root.textContent).not.toContain("我喜欢茶");
    filter("candidates");
    expect(f.root.textContent).toContain("我喜欢茶"); expect(f.root.textContent).not.toContain("我住在上海");
    filter("all");
    const search = f.root.querySelector('input[type="search"]') as HTMLInputElement;
    search.value = "不存在的内容"; search.dispatchEvent(new Event("input"));
    expect(f.root.textContent).toContain("没有找到符合搜索条件的内容");
    expect(f.actions).toEqual([]);
  });
  it("confirms, corrects and forgets with revisioned actions, then reloads displayed state", async () => {
    const f = fixture(); await f.panel.load(); click(f.root, "confirm");
    await vi.waitFor(() => expect(f.root.querySelector('[data-memory-action="correct"]')).not.toBeNull());
    expect(f.actions[0]).toEqual({ kind: "confirm", id: "candidate-1", expectedRevision: 1, contentHash: "a".repeat(64) });
    expect(f.root.textContent).toContain("已确认");
    click(f.root, "correct");
    const input = f.root.querySelector("textarea")!; input.value = "我喜欢咖啡";
    click(f.root, "save-correction");
    await vi.waitFor(() => expect(f.root.textContent).toContain("我喜欢咖啡"));
    expect(f.actions[1]).toEqual({ kind: "correct", id: "fact-1", expectedRevision: 2, text: "我喜欢咖啡" });
    click(f.root, "forget");
    await vi.waitFor(() => expect(f.root.textContent).not.toContain("我喜欢咖啡"));
    expect(f.actions[2]).toEqual({ kind: "forget", id: "fact-1", expectedRevision: 3 });
    expect(f.root.textContent).toContain("已遗忘");
  });
  it("rejects a candidate and does not mistake the successful rejected outcome for failure", async () => {
    const f = fixture(); await f.panel.load(); click(f.root, "reject");
    await vi.waitFor(() => expect(f.root.textContent).toContain("已拒绝"));
    expect(f.actions).toEqual([{ kind: "reject", id: "candidate-1", expectedRevision: 1 }]);
    expect(f.root.querySelector('[data-memory-action="confirm"]')).toBeNull();
  });
  it("shows an unavailable backend as a status rather than an empty memory, and disables actions", async () => {
    const f = fixture(); f.state.backendStatus = { available: false, reason: "MEMORY_BACKEND_UNAVAILABLE" };
    await f.panel.load();
    expect(f.root.textContent).toContain("记忆服务暂不可用"); expect(f.root.textContent).not.toContain("没有待确认");
    expect(f.root.textContent).not.toContain("MEMORY_BACKEND_UNAVAILABLE");
    expect([...f.root.querySelectorAll<HTMLButtonElement>("[data-memory-action]")].every((node) => node.disabled)).toBe(true);
  });
  it("shows read failures and missing interfaces without raw exception details", async () => {
    const f = fixture();
    f.api.getState = async () => { throw new Error("/private/account secret"); };
    await f.panel.load();
    expect(f.root.textContent).toContain("读取失败"); expect(f.root.textContent).not.toMatch(/private|secret|没有待确认/);
    expect(f.seen.at(-1)).toBeNull();
    const root = document.createElement("div"); await createMemoryEntriesPanel(root, undefined).load();
    expect(root.textContent).toContain("记忆接口不可用");
  });
  it("double click submits once and keeps actions disabled while pending", async () => {
    const f = fixture(); let release!: () => void;
    const original = f.api.applyAction;
    f.api.applyAction = async (action) => { await new Promise<void>((resolve) => { release = resolve; }); return original(action); };
    await f.panel.load(); click(f.root, "confirm"); click(f.root, "confirm");
    expect([...f.root.querySelectorAll<HTMLButtonElement>("[data-memory-action]")].every((button) => button.disabled)).toBe(true);
    release(); await vi.waitFor(() => expect(f.actions).toHaveLength(1));
  });
  it("renders hostile assertion, candidate, backend reason and provenance only as text", async () => {
    const f = fixture(); const hostile = '<img src=x onerror="window.pwned=true">';
    f.state.facts = [fact(hostile)]; f.state.candidates[0].assertion = hostile;
    f.state.candidates[0].reason = hostile; f.state.backendStatus.reason = hostile;
    f.api.auditSource = async () => ({ factId: "fact-1", revision: 2, status: "eligible", reason: hostile, sources: [{ sourceId: hostile, revision: 1, kind: "automatic", validity: hostile, occurredAt: 1000 }] });
    await f.panel.load(); click(f.root, "source");
    await vi.waitFor(() => expect(f.root.textContent).toContain("有依据"));
    expect(f.root.textContent).toContain(hostile); expect(f.root.querySelector("img")).toBeNull(); expect(f.root.querySelector("script")).toBeNull();
  });
  it("shows source kind and status without raw source ids", async () => {
    const f = fixture(); f.state.facts = [fact()]; await f.panel.load(); click(f.root, "source");
    await vi.waitFor(() => expect(f.root.textContent).toContain("你确认过"));
    expect(f.root.textContent).toContain("有依据"); expect(f.root.textContent).not.toContain("settings-source");
  });
  it("shows stale/error results without claiming success and refreshes stale state", async () => {
    const f = fixture(); f.api.applyAction = async () => ({ status: "rejected", reason: "MEMORY_REVISION_CONFLICT" });
    await f.panel.load(); click(f.root, "confirm");
    await vi.waitFor(() => expect(f.root.textContent).toContain("列表已刷新"));
    expect(f.root.textContent).not.toContain("已确认");
  });
  it("source read failures are visible and contain no raw exception details", async () => {
    const f = fixture(); f.state.facts = [fact()]; f.api.auditSource = async () => { throw new Error("private-token"); };
    await f.panel.load(); click(f.root, "source");
    await vi.waitFor(() => expect(f.root.textContent).toContain("来源读取失败"));
    expect(f.root.textContent).not.toContain("private-token");
  });
});

it('shows the effective period before candidate confirmation',async()=>{
 const f=fixture();f.state.candidates[0].time={validFrom:Date.parse('2026-01-01Z'),validTo:Date.parse('2026-02-01Z'),referenceTime:Date.parse('2026-03-09Z')};
 await f.panel.load();expect(f.root.textContent).toContain('生效于');expect(f.root.textContent).toContain('有效至');expect(f.root.querySelector('[data-memory-action="confirm"]')).not.toBeNull();
});
