// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApprovalDetail, ToastPushPayload } from "../../shared/toast-types";
vi.mock("../ui/theme", () => ({}));
vi.mock("../../shared/renderer-base", () => ({ resolveAsset: (path: string) => "/assets/" + path }));
const api = { getAll: vi.fn(), onPush: vi.fn(), onRemove: vi.fn(), clicked: vi.fn(), dismissed: vi.fn(), reportHeight: vi.fn(), resolveApproval: vi.fn(), inspectApproval: vi.fn() }, play = vi.fn();
let resize: () => void;
const item = (id: string, patch: Partial<ToastPushPayload> = {}): ToastPushPayload => ({ id, kind: "ask-choice", sourceId: id, tier: "notify", title: id, createdAt: 1, target: { type: "window", window: "chat" }, sound: false, ...patch });
const ids = () => [...document.querySelectorAll<HTMLElement>(".toast-card")].map(e => e.dataset.id);
const push = (value: ToastPushPayload) => api.onPush.mock.calls[0][0](value);
const remove = (id: string) => api.onRemove.mock.calls[0][0](id);
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); api.getAll.mockResolvedValue([]); api.resolveApproval.mockResolvedValue({ ok: true }); api.inspectApproval.mockResolvedValue({ state: "expired", approvalId: "expired-default" }); play.mockResolvedValue(undefined); Object.assign(window, { toast: api }); document.body.innerHTML = '<main id="toast-stack"></main>'; vi.stubGlobal("Audio", class { currentTime = 0; play = play; }); vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (window as any).toast; });
async function load() { await import("./toast"); await Promise.resolve(); }
it("restores sorted cards without playing sound", async () => { api.getAll.mockResolvedValue([item("late", { createdAt: 5 }), item("action", { tier: "action-pending", createdAt: 9 }), item("early")]); await load(); expect(ids()).toEqual(["action", "early", "late"]); expect(play).not.toHaveBeenCalled(); });
it("renders untrusted text as text and reports click/dismiss separately", async () => { await load(); push(item("a", { title: "<img onerror=bad>", summary: "<script>bad</script>" })); const card = document.querySelector<HTMLElement>(".toast-card")!; expect(card.querySelector(".toast-card__title")?.textContent).toBe("<img onerror=bad>"); expect(card.querySelector("script")).toBeNull(); card.querySelector<HTMLButtonElement>("button")!.click(); expect(api.dismissed).toHaveBeenCalledWith("a"); expect(api.clicked).not.toHaveBeenCalled(); card.click(); expect(api.clicked).toHaveBeenCalledWith("a"); expect(ids()).toEqual(["a"]); });
it("updates existing cards, hides empty summaries, and keeps one card per ID", async () => { await load(); push(item("a", { summary: "before" })); const card = document.querySelector(".toast-card"); push(item("a", { title: "after", summary: "" })); expect(document.querySelector(".toast-card")).toBe(card); expect(ids()).toEqual(["a"]); expect(document.querySelector(".toast-card__title")?.textContent).toBe("after"); expect(document.querySelector<HTMLElement>(".toast-card__summary")?.hidden).toBe(true); });
it("removes after the animation deadline and ignores duplicate/missing removals", async () => { await load(); push(item("a")); remove("missing"); remove("a"); remove("a"); expect(document.querySelector(".toast-card--leaving")).not.toBeNull(); await vi.advanceTimersByTimeAsync(219); expect(ids()).toEqual(["a"]); await vi.advanceTimersByTimeAsync(1); expect(ids()).toEqual([]); });
it("cancels removal when the same ID is pushed again", async () => { await load(); push(item("a")); remove("a"); await vi.advanceTimersByTimeAsync(100); push(item("a", { title: "returned" })); await vi.advanceTimersByTimeAsync(220); expect(ids()).toEqual(["a"]); expect(document.querySelector(".toast-card--leaving")).toBeNull(); });
it("plays requested sounds and contains playback rejection", async () => { await load(); play.mockRejectedValue(Error("blocked")); push(item("a", { sound: true, tier: "action-pending" })); push(item("b", { sound: true })); await Promise.resolve(); expect(play).toHaveBeenCalledTimes(2); expect(ids()).toEqual(["a", "b"]); });
it("clamps visible-card height and reports scroll height only when it changes", async () => { await load(); const stack = document.getElementById("toast-stack")!; Object.defineProperty(stack, "scrollHeight", { configurable: true, value: 250 }); for (let i = 0; i < 5; i++) push(item(String(i), { createdAt: i })); expect(stack.style.maxHeight).toBe("64px"); resize(); expect(api.reportHeight).toHaveBeenCalledExactlyOnceWith(250); remove("4"); await vi.advanceTimersByTimeAsync(220); expect(stack.style.maxHeight).toBe(""); });
it("does not replace a push received while restoration was pending", async () => { let resolve!: (values: unknown[]) => void; api.getAll.mockReturnValue(new Promise(r => { resolve = r; })); await import("./toast"); push(item("a", { title: "new" })); resolve([item("a", { title: "old" })]); await Promise.resolve(); expect(document.querySelector(".toast-card__title")?.textContent).toBe("new"); });
it("contains restore failures and accepts later pushes", async () => { api.getAll.mockRejectedValue(Error("offline")); await load(); push(item("a")); expect(ids()).toEqual(["a"]); });
it("supports a missing stack", async () => { document.body.innerHTML = ""; await load(); expect(api.getAll).not.toHaveBeenCalled(); expect(api.onPush).not.toHaveBeenCalled(); });

describe("approval review (toast)", () => {
  const reviewItem = (id: string, patch: Partial<ToastPushPayload> = {}): ToastPushPayload =>
    item(id, {
      kind: "approval",
      tier: "action-pending",
      title: "流萤在等你的批准",
      summary: "Edit workspace file",
      review: { approvalId: "approve-1" },
      ...patch,
    });

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const actionLabelsOf = (card: Element): string[] =>
    [...card.querySelectorAll<HTMLButtonElement>(".toast-card__actions button")].map((button) => button.textContent ?? "");

  it("hides the close button on approval reminders while keeping it on non-approval reminders", async () => {
    await load();
    push(reviewItem("rev-card"));
    push(item("bare-app-card", {
      kind: "approval",
      tier: "action-pending",
      title: "流萤在等你的批准",
      summary: "Generic approval",
    }));
    push(item("choice-card", {
      kind: "ask-choice",
      tier: "action-pending",
      title: "流萤想问你一个问题",
      summary: "Pick an option",
    }));

    const cards = new Map<string, HTMLElement>(
      [...document.querySelectorAll<HTMLElement>(".toast-card")].map((card) => [card.dataset.id!, card]),
    );
    expect(cards.get("rev-card")?.querySelector(".toast-card__close")).toBeNull();
    expect(cards.get("bare-app-card")?.querySelector(".toast-card__close")).toBeNull();
    expect(cards.get("choice-card")?.querySelector(".toast-card__close")).not.toBeNull();
  });

  it("inspects once without reporting clicked or dismissed and disables the button while pending", async () => {
    const pendingInspect = deferred<ToastApprovalDetail>();
    api.inspectApproval.mockReturnValue(pendingInspect.promise);
    await load();
    push(reviewItem("rev-1", { review: { approvalId: "approve-inspect-1" } }));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    const inspectBtn = card.querySelector<HTMLButtonElement>(".toast-card__inspect")!;
    expect(actionLabelsOf(card)).toEqual(["查看审批"]);
    expect(inspectBtn.disabled).toBe(false);

    inspectBtn.click();

    expect(api.inspectApproval.mock.calls).toEqual([["approve-inspect-1"]]);
    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();
    const loadingBtn = card.querySelector<HTMLButtonElement>(".toast-card__inspect")!;
    expect(loadingBtn.disabled).toBe(true);
    expect(loadingBtn.textContent).toBe("正在核实…");

    loadingBtn.click();
    expect(api.inspectApproval).toHaveBeenCalledTimes(1);

    pendingInspect.resolve({
      state: "expired",
      approvalId: "approve-inspect-1",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(card.querySelector(".toast-card__review-notice")?.textContent).toBe("审批已失效");
  });

  it.each<{
    label: string;
    detail: ToastApprovalDetail;
    expectedTexts: string[];
    expectedButtons: string[];
    expectedArgs: Array<[string, string]>;
  }>([
    {
      label: "pending with session title and agentId",
      detail: {
        state: "pending",
        approvalId: "approve-1",
        toolName: "Write File",
        toolId: "write_file",
        agentId: "partner-editor",
        session: { id: "sess-1", title: "重构文档清单" },
        args: [{ key: "path", value: "docs/plan.md" }, { key: "mode", value: "overwrite" }],
      },
      expectedTexts: ["所属会话：重构文档清单", "发起伙伴：partner-editor", "工具：Write File"],
      expectedButtons: ["批准", "拒绝"],
      expectedArgs: [["path", "docs/plan.md"], ["mode", "overwrite"]],
    },
    {
      label: "pending falling back to session id when title absent",
      detail: {
        state: "pending",
        approvalId: "approve-1",
        toolName: "Run Shell",
        toolId: "bash",
        session: { id: "sess-fallback-42" },
        args: [{ key: "command", value: "npm test" }],
      },
      expectedTexts: ["所属会话：sess-fallback-42", "工具：Run Shell"],
      expectedButtons: ["批准", "拒绝"],
      expectedArgs: [["command", "npm test"]],
    },
    {
      label: "runless",
      detail: {
        state: "runless",
        approvalId: "approve-1",
        toolName: "Run Shell",
        toolId: "bash",
        agentId: "cron-worker",
        args: [{ key: "command", value: "echo ok" }],
      },
      expectedTexts: ["所属会话：无所属会话", "发起伙伴：cron-worker", "工具：Run Shell", "这项审批没有所属任务，无法确认来源，不能在这里批准"],
      expectedButtons: [],
      expectedArgs: [["command", "echo ok"]],
    },
    {
      label: "unverified",
      detail: {
        state: "unverified",
        approvalId: "approve-1",
        toolName: "Write File",
        toolId: "write_file",
        agentId: "partner-x",
        args: [{ key: "path", value: "README.md" }],
      },
      expectedTexts: ["发起伙伴：partner-x", "工具：Write File", "无法核实这项审批属于哪个会话，不能在这里批准"],
      expectedButtons: ["打开聊天窗口"],
      expectedArgs: [["path", "README.md"]],
    },
    {
      label: "expired",
      detail: {
        state: "expired",
        approvalId: "approve-1",
      },
      expectedTexts: ["审批已失效"],
      expectedButtons: [],
      expectedArgs: [],
    },
  ])("renders $label review state with exact text and button list", async ({ detail, expectedTexts, expectedButtons, expectedArgs }) => {
    api.inspectApproval.mockResolvedValue(detail);
    await load();
    push(reviewItem("rev-state"));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    card.querySelector<HTMLButtonElement>(".toast-card__inspect")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(actionLabelsOf(card)).toEqual(expectedButtons);
    const metaAndNotice = [...card.querySelectorAll<HTMLElement>(".toast-card__review-meta, .toast-card__review-notice")]
      .map((node) => node.textContent ?? "");
    expect(metaAndNotice).toEqual(expectedTexts);

    const renderedArgs = [...card.querySelectorAll<HTMLElement>(".toast-card__review-arg")].map((row) => [
      row.querySelector(".toast-card__review-arg-key")?.textContent ?? "",
      row.querySelector(".toast-card__review-arg-value")?.textContent ?? "",
    ]);
    expect(renderedArgs).toEqual(expectedArgs);

    if (detail.state === "unverified") {
      card.querySelector<HTMLButtonElement>(".toast-card__open-chat")!.click();
      expect(api.clicked.mock.calls).toEqual([["rev-state"]]);
      expect(api.resolveApproval).not.toHaveBeenCalled();
    }
    expect(ids()).toEqual(["rev-state"]);
  });

  it("submits pending review approval once, expires on ok:false, and recovers buttons on rejection", async () => {
    api.inspectApproval.mockResolvedValue({
      state: "pending",
      approvalId: "approve-1",
      toolName: "Write File",
      toolId: "write_file",
      session: { id: "sess-1", title: "会话一" },
      args: [{ key: "path", value: "a.txt" }],
    } satisfies ToastApprovalDetail);
    api.resolveApproval
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce({ ok: false });

    await load();
    push(reviewItem("rev-ans"));
    const card = document.querySelector<HTMLElement>(".toast-card")!;
    card.querySelector<HTMLButtonElement>(".toast-card__inspect")!.click();
    await Promise.resolve();
    await Promise.resolve();

    // Rejection re-enables buttons so the user can try again
    const approve = card.querySelector<HTMLButtonElement>(".toast-card__approve")!;
    const deny = card.querySelector<HTMLButtonElement>(".toast-card__deny")!;
    approve.click();
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    expect(api.resolveApproval.mock.calls).toEqual([["approve-1", true]]);
    approve.click();
    deny.click();
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    await Promise.resolve();
    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
    expect(api.clicked).not.toHaveBeenCalled();

    // Retry resolves { ok: false }: replaces action buttons with expired notice
    approve.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.resolveApproval.mock.calls).toEqual([
      ["approve-1", true],
      ["approve-1", true],
    ]);
    expect(actionLabelsOf(card)).toEqual([]);
    expect(card.querySelector(".toast-card__review-notice")?.textContent).toBe("审批已失效");
    expect(api.clicked).not.toHaveBeenCalled();
    expect(ids()).toEqual(["rev-ans"]);
  });

  it("keeps pending approval buttons locked after ok:true until toast:remove arrives", async () => {
    api.inspectApproval.mockResolvedValue({
      state: "pending",
      approvalId: "approve-1",
      toolName: "Write File",
      toolId: "write_file",
      session: { id: "sess-1" },
      args: [],
    } satisfies ToastApprovalDetail);
    const resolvePending = deferred<{ ok: boolean }>();
    api.resolveApproval.mockReturnValue(resolvePending.promise);

    await load();
    push(reviewItem("rev-ok"));
    const card = document.querySelector<HTMLElement>(".toast-card")!;
    card.querySelector<HTMLButtonElement>(".toast-card__inspect")!.click();
    await Promise.resolve();
    await Promise.resolve();

    const approve = card.querySelector<HTMLButtonElement>(".toast-card__approve")!;
    const deny = card.querySelector<HTMLButtonElement>(".toast-card__deny")!;
    approve.click();
    resolvePending.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(actionLabelsOf(card)).toEqual(["批准", "拒绝"]);
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    approve.click();
    deny.click();
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(["rev-ok"]);
  });

  it("shows temporary verification error and re-enables inspect button when inspectApproval rejects", async () => {
    api.inspectApproval
      .mockRejectedValueOnce(new Error("ipc timeout"))
      .mockResolvedValueOnce({ state: "expired", approvalId: "approve-1" });

    await load();
    push(reviewItem("rev-err"));
    const card = document.querySelector<HTMLElement>(".toast-card")!;
    card.querySelector<HTMLButtonElement>(".toast-card__inspect")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(card.querySelector(".toast-card__review-notice")?.textContent).toBe("暂时无法核实，请稍后再试");
    expect(actionLabelsOf(card)).toEqual(["查看审批"]);
    const retryBtn = card.querySelector<HTMLButtonElement>(".toast-card__inspect")!;
    expect(retryBtn.disabled).toBe(false);

    retryBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.inspectApproval.mock.calls).toEqual([["approve-1"], ["approve-1"]]);
    expect(card.querySelector(".toast-card__review-notice")?.textContent).toBe("审批已失效");
    expect(actionLabelsOf(card)).toEqual([]);
  });

  it("preserves expanded review details and disabled buttons when the same ID is pushed again", async () => {
    api.inspectApproval.mockResolvedValue({
      state: "pending",
      approvalId: "approve-1",
      toolName: "Write File",
      toolId: "write_file",
      session: { id: "sess-1", title: "会话一" },
      args: [{ key: "path", value: "file.ts" }],
    } satisfies ToastApprovalDetail);
    const resolvePending = deferred<{ ok: boolean }>();
    api.resolveApproval.mockReturnValue(resolvePending.promise);

    await load();
    push(reviewItem("rev-keep", { title: "流萤在等你的批准", summary: "Write File" }));
    const card = document.querySelector<HTMLElement>(".toast-card")!;
    card.querySelector<HTMLButtonElement>(".toast-card__inspect")!.click();
    await Promise.resolve();
    await Promise.resolve();

    card.querySelector<HTMLButtonElement>(".toast-card__deny")!.click();
    expect(card.querySelector<HTMLButtonElement>(".toast-card__approve")?.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>(".toast-card__deny")?.disabled).toBe(true);

    // Same ID + same approvalId re-pushed: keeps detail expanded and buttons disabled
    push(reviewItem("rev-keep", { title: "更新标题", summary: "Write File (2)" }));

    expect(document.querySelector(".toast-card")).toBe(card);
    expect(card.querySelector(".toast-card__title")?.textContent).toBe("更新标题");
    expect(card.querySelector(".toast-card__summary")?.textContent).toBe("Write File (2)");
    expect(card.querySelector(".toast-card__review-meta")?.textContent).toBe("所属会话：会话一");
    expect(actionLabelsOf(card)).toEqual(["批准", "拒绝"]);
    expect(card.querySelector<HTMLButtonElement>(".toast-card__approve")?.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>(".toast-card__deny")?.disabled).toBe(true);

    resolvePending.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("renders untrusted session title, agentId, toolName, and arguments literally without HTML injection", async () => {
    const xssImg = "<img src=x onerror=bad()>";
    const xssScript = "<script>bad()</script>";
    api.inspectApproval.mockResolvedValue({
      state: "pending",
      approvalId: "approve-xss",
      toolName: xssScript,
      toolId: "write_file",
      agentId: xssImg,
      session: { id: "sess-xss", title: `${xssImg} ${xssScript}` },
      args: [{ key: xssScript, value: xssImg }],
    } satisfies ToastApprovalDetail);

    await load();
    push(reviewItem("rev-xss", { review: { approvalId: "approve-xss" } }));
    const card = document.querySelector<HTMLElement>(".toast-card")!;
    card.querySelector<HTMLButtonElement>(".toast-card__inspect")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(card.querySelectorAll("script")).toHaveLength(0);
    expect(card.querySelectorAll(".toast-card__body img")).toHaveLength(0);
    expect(card.querySelectorAll("img")).toHaveLength(1);
    const metaTexts = [...card.querySelectorAll<HTMLElement>(".toast-card__review-meta")].map((n) => n.textContent);
    expect(metaTexts).toEqual([
      `所属会话：${xssImg} ${xssScript}`,
      `发起伙伴：${xssImg}`,
      `工具：${xssScript}`,
    ]);
    expect(card.querySelector(".toast-card__review-arg-key")?.textContent).toBe(xssScript);
    expect(card.querySelector(".toast-card__review-arg-value")?.textContent).toBe(xssImg);
  });
});
