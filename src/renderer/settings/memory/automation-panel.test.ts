// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import * as module from "./automation-panel";
beforeEach(() => document.body.replaceChildren());
function fixture() {
  const state = { available: true, config: { revision: 0, language: false, responseStyle: false }, budget: { day: 0, requests: 0, units: 0, closed: false }, counts: { unsent: 0, "result-unknown": 0, "result-saved": 0, applied: 0, blocked: 0 } };
  const api = { state: vi.fn(async () => structuredClone(state)), configure: vi.fn(async (input: any) => { state.config = { revision: input.expectedRevision + 1, language: input.language, responseStyle: input.responseStyle }; return { status: "updated", state: structuredClone(state) }; }) }, root = document.createElement("section"); document.body.append(root);
  expect(typeof module.createMemoryAutomationPanel).toBe("function"); const panel = module.createMemoryAutomationPanel(root, api); return { state, api, root, panel };
}
const toggle = (f: ReturnType<typeof fixture>, name: string, value: boolean) => { const input = f.root.querySelector<HTMLInputElement>(`[data-memory-automation="${name}"]`)!; input.checked = value; input.dispatchEvent(new Event("change", { bubbles: true })); };
it("shows only two default-off automatic-save controls and the confirmation boundary", async () => {
  const f = fixture(); await f.panel.load(); expect([...f.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.checked)).toEqual([false, false]); expect(f.root.textContent).toContain("仍需你确认"); expect(f.api.configure).not.toHaveBeenCalled();
});
it.each(["language", "responseStyle"])("saves only the selected %s switch with the current revision", async name => {
  const f = fixture(); await f.panel.load(); toggle(f, name, true); await vi.waitFor(() => expect(f.api.configure).toHaveBeenCalledOnce());
  expect(f.api.configure).toHaveBeenCalledWith({ expectedRevision: 0, language: name === "language", responseStyle: name === "responseStyle" }); await vi.waitFor(() => expect(f.root.textContent).toContain("已保存"));
});
it("refreshes stale consent without silently retrying the user's selection", async () => {
  const f = fixture(); await f.panel.load(); f.state.config = { revision: 2, language: false, responseStyle: true }; f.api.configure.mockResolvedValue({ status: "rejected", reason: "MEMORY_REVISION_CONFLICT" } as any);
  toggle(f, "language", true); await vi.waitFor(() => expect(f.root.textContent).toContain("设置已变化")); expect(f.api.configure).toHaveBeenCalledOnce(); expect(f.root.querySelector<HTMLInputElement>('[data-memory-automation="language"]')!.checked).toBe(false);
});
it("disables unavailable controls and does not render raw private error details", async () => {
  const f = fixture(); f.api.state.mockRejectedValue(Error("PRIVATE_PROFILE_KEY")); await f.panel.load(); expect(f.root.textContent).toContain("暂不可用"); expect(f.root.textContent).not.toContain("PRIVATE_PROFILE_KEY"); expect([...f.root.querySelectorAll<HTMLInputElement>("input")].every(input => input.disabled)).toBe(true);
});
