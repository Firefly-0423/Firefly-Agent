// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastPushPayload } from "../../shared/toast-types";
vi.mock("../ui/theme", () => ({}));
vi.mock("../../shared/renderer-base", () => ({ resolveAsset: (path: string) => "/assets/" + path }));
const api = { getAll: vi.fn(), onPush: vi.fn(), onRemove: vi.fn(), clicked: vi.fn(), dismissed: vi.fn(), reportHeight: vi.fn(), resolveApproval: vi.fn() }, play = vi.fn();
let resize: () => void;
const item = (id: string, patch: Partial<ToastPushPayload> = {}): ToastPushPayload => ({ id, kind: "ask-choice", sourceId: id, tier: "notify", title: id, createdAt: 1, target: { type: "window", window: "chat" }, sound: false, ...patch });
const ids = () => [...document.querySelectorAll<HTMLElement>(".toast-card")].map(e => e.dataset.id);
const push = (value: ToastPushPayload) => api.onPush.mock.calls[0][0](value);
const remove = (id: string) => api.onRemove.mock.calls[0][0](id);
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); api.getAll.mockResolvedValue([]); api.resolveApproval.mockResolvedValue({ ok: true }); play.mockResolvedValue(undefined); Object.assign(window, { toast: api }); document.body.innerHTML = '<main id="toast-stack"></main>'; vi.stubGlobal("Audio", class { currentTime = 0; play = play; }); vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} }); });
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

describe("approval actions (ChatPage G3)", () => {
  const approvalItem = (id: string, patch: Partial<ToastPushPayload> = {}): ToastPushPayload =>
    item(id, {
      kind: "approval",
      tier: "action-pending",
      title: "需要批准执行操作",
      summary: "工具：run_command · 来源：全局快捷键",
      approval: { approvalId: "approve-1", toolName: "run_command", source: "global-hotkey" },
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

  const buttonsOf = (card: Element) => ({
    approve: card.querySelector<HTMLButtonElement>(".toast-card__approve")!,
    deny: card.querySelector<HTMLButtonElement>(".toast-card__deny")!,
  });

  it("renders approve and deny buttons without a close button and ignores card body clicks", async () => {
    await load();
    push(approvalItem("a"));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    expect(card.classList.contains("toast-card--approval")).toBe(true);
    expect(card.querySelector(".toast-card__close")).toBeNull();

    const bodyButtons = [...card.querySelectorAll<HTMLButtonElement>(".toast-card__body .toast-card__actions button")];
    expect(bodyButtons.map((button) => ({
      className: button.className,
      text: button.textContent,
      type: button.type,
      disabled: button.disabled,
    }))).toEqual([
      { className: "toast-card__approve", text: "批准", type: "button", disabled: false },
      { className: "toast-card__deny", text: "拒绝", type: "button", disabled: false },
    ]);

    card.querySelector<HTMLElement>(".toast-card__title")!.click();
    card.querySelector<HTMLElement>(".toast-card__summary")!.click();
    card.click();

    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it.each([
    { label: "批准", selector: ".toast-card__approve", allowed: true },
    { label: "拒绝", selector: ".toast-card__deny", allowed: false },
  ])("resolves $label ($allowed) once and keeps both buttons disabled while pending and after ok:true", async ({ selector, allowed }) => {
    const pending = deferred<{ ok: boolean }>();
    api.resolveApproval.mockReturnValue(pending.promise);
    await load();
    push(approvalItem("a"));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    const { approve, deny } = buttonsOf(card);

    card.querySelector<HTMLButtonElement>(selector)!.click();

    expect(api.resolveApproval.mock.calls).toEqual([["approve-1", allowed]]);
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();

    approve.click();
    deny.click();
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    approve.click();
    deny.click();
    expect(api.resolveApproval.mock.calls).toEqual([["approve-1", allowed]]);
    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();
  });

  it("keeps both buttons disabled when resolveApproval returns ok:false", async () => {
    api.resolveApproval.mockResolvedValue({ ok: false });
    await load();
    push(approvalItem("a"));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    const { approve, deny } = buttonsOf(card);

    approve.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.resolveApproval.mock.calls).toEqual([["approve-1", true]]);
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    approve.click();
    deny.click();
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);
    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();
  });

  it("re-enables both buttons on rejection without unhandled rejection so the user can retry", async () => {
    api.resolveApproval
      .mockRejectedValueOnce(new Error("ipc channel closed"))
      .mockResolvedValueOnce({ ok: true });
    await load();
    push(approvalItem("a"));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    const { approve, deny } = buttonsOf(card);

    approve.click();
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();

    deny.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.resolveApproval.mock.calls).toEqual([
      ["approve-1", true],
      ["approve-1", false],
    ]);
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
  });

  it("re-enables both buttons when resolveApproval throws synchronously", async () => {
    api.resolveApproval
      .mockImplementationOnce(() => { throw new Error("sync failure"); })
      .mockResolvedValueOnce({ ok: true });
    await load();
    push(approvalItem("a"));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    const { approve, deny } = buttonsOf(card);

    approve.click();
    await Promise.resolve();

    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);

    approve.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.resolveApproval.mock.calls).toEqual([
      ["approve-1", true],
      ["approve-1", true],
    ]);
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
  });

  it("keeps approval buttons disabled when the same ID is pushed again while waiting", async () => {
    const pending = deferred<{ ok: boolean }>();
    api.resolveApproval.mockReturnValue(pending.promise);
    await load();
    push(approvalItem("a", { title: "第一次推送", summary: "tool-a · src-a" }));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    const { approve, deny } = buttonsOf(card);
    approve.click();
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    push(approvalItem("a", { title: "重复推送", summary: "tool-a · src-a (updated)" }));

    expect(document.querySelector(".toast-card")).toBe(card);
    expect(card.querySelector(".toast-card__title")?.textContent).toBe("重复推送");
    expect(card.querySelector(".toast-card__summary")?.textContent).toBe("tool-a · src-a (updated)");
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    approve.click();
    deny.click();
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);
    expect(api.clicked).not.toHaveBeenCalled();
    expect(api.dismissed).not.toHaveBeenCalled();

    pending.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("renders untrusted approval title, summary, toolName, and source literally without HTML injection", async () => {
    await load();
    const xssImg = "<img src=x onerror=bad()>";
    const xssScript = "<script>bad()</script>";
    push(approvalItem("a", {
      title: xssImg,
      summary: `${xssImg} ${xssScript}`,
      approval: { approvalId: "approve-xss", toolName: xssScript, source: xssImg },
    }));

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    expect(card.querySelectorAll("script")).toHaveLength(0);
    expect(card.querySelectorAll(".toast-card__body img")).toHaveLength(0);
    expect(card.querySelectorAll("img")).toHaveLength(1);
    expect(card.querySelector(".toast-card__title")?.textContent).toBe(xssImg);
    expect(card.querySelector(".toast-card__summary")?.textContent).toBe(`${xssImg} ${xssScript}`);
  });

  it("restores approval cards via getAll and removes them with the exit animation on toast:remove", async () => {
    api.getAll.mockResolvedValue([approvalItem("a")]);
    await load();

    const card = document.querySelector<HTMLElement>(".toast-card")!;
    expect(card.classList.contains("toast-card--approval")).toBe(true);
    expect(card.querySelector(".toast-card__close")).toBeNull();
    expect(card.querySelectorAll(".toast-card__actions button")).toHaveLength(2);

    remove("a");
    expect(card.classList.contains("toast-card--leaving")).toBe(true);
    await vi.advanceTimersByTimeAsync(219);
    expect(ids()).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual([]);
  });
});
