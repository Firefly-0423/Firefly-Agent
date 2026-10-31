// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ExternalSkill, ExternalSkillsApi, ExternalResult, ExternalPrepared, ExternalCommitted, ExternalSkillErrorCode } from "../../../../../shared/external-skills";
import { ChatPagePanelHost } from "./ChatPagePanelHost";
import { setUiLocale } from "../../../i18n";

// Other routes are inert. The actual host's skill route and both Skills panels remain real.
vi.mock("./ModelModePanel", () => ({ ModelModePanel: () => null }));
vi.mock("./PluginModePanel", () => ({ PluginModePanel: () => null }));
vi.mock("./ToolModePanel", () => ({ ToolModePanel: () => null }));
const originalSettings = window.settings;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let root: Root | undefined, element: HTMLDivElement;
const ok = <T,>(value: T): ExternalResult<T> => ({ ok: true, value });
const failure = (code: ExternalSkillErrorCode = "NETWORK_FAILED"): ExternalResult<never> => ({ ok: false, code, error: "Fixture error", retryable: code === "NETWORK_FAILED" });
type Source = "firefly" | "openai" | "anthropic";
const REPOSITORIES: Record<Source, string> = { firefly: "Firefly-0423/firefly-skills", openai: "openai/plugins", anthropic: "anthropics/skills" };
const fixture = (name = "Fixture A", sourceId: Source = "firefly"): ExternalSkill => ({
  id: `external-${sourceId}-${name === "Fixture B" ? "b" : "a"}`, sourceId, upstreamName: name, description: "Synthetic instruction only",
  bundle: { name: "Fixture bundle", version: "bundle-9", license: "MIT" }, repository: REPOSITORIES[sourceId], path: "skills/fixture", commit: "a".repeat(40),
  licenses: [{ path: "LICENSE", sha256: "b".repeat(64), spdx: "MIT", covers: ["SKILL.md", "references/readme.txt"] }],
  files: [{ path: "SKILL.md", bytes: 200, blobSha1: "c".repeat(40), sha256: "d".repeat(64) }], review: "approved", blockers: [],
});
const prepared = (skill: ExternalSkill): ExternalPrepared => ({ token: "e".repeat(64), expiresAt: Date.now() + 600000, skill, contentSha256: "f".repeat(64) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function mount(overrides: Partial<ExternalSkillsApi> = {}, strict = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; setUiLocale("en");
  const api = {
    list: vi.fn(async (sourceId: Source) => ok([fixture("Fixture A", sourceId)])),
    detail: vi.fn(async (sourceId: Source, id: string) => ok({ ...fixture(id.endsWith("b") ? "Fixture B" : "Fixture A", sourceId), id })),
    prepare: vi.fn(async (sourceId: Source, id: string) => ok(prepared({ ...fixture(id.endsWith("b") ? "Fixture B" : "Fixture A", sourceId), id }))),
    commit: vi.fn(async (_token: string) => ok<ExternalCommitted>({ id: fixture().id, enabled: false, contentSha256: "f".repeat(64) })),
    cancel: vi.fn(async () => ok({ status: "cancelled" as const })), ...overrides,
  };
  const getCatalog = vi.fn(async () => []), enable = vi.fn(async () => ({ ok: true }));
  window.settings = { externalSkills: api, getSkillCatalog: getCatalog, getSkillModeOverrides: async () => ({}), setSkillEnabled: enable } as unknown as typeof window.settings;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => { const host = React.createElement(ChatPagePanelHost, { panel: "skill" }); root!.render(strict ? React.createElement(React.StrictMode, null, host) : host); });
  return { api, getCatalog, enable };
}
const buttons = () => [...element.querySelectorAll<HTMLButtonElement>("button")];
// A sidebar entry carries a count after its label, so match its label on its own.
const labelOf = (node: HTMLButtonElement) => node.querySelector(".ff-panel-sidebar__item-label")?.textContent ?? node.textContent;
const button = (text: string) => { const found = buttons().find(node => labelOf(node) === text); expect(found, `Missing accessible button: ${text}`).toBeDefined(); return found!; };
async function click(node: HTMLElement) { await act(async () => { node.click(); }); }
async function market() { await click(button("External marketplace")); }
async function detail(name = "Fixture A") { await click(button(name)); }
async function preview(name = "Fixture A") { await detail(name); await click(button("Prepare import")); }
async function source(value: Source) { await click(button(REPOSITORIES[value])); }
async function input(value: string) { const node = element.querySelector<HTMLInputElement>('.external-skills input[type="search"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
const text = () => element.textContent ?? "";
const status = () => [...element.querySelectorAll('[role="status"]')].map(node => node.textContent).join(" ");
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = undefined; element?.remove(); window.settings = originalSettings; setUiLocale("zh-CN"); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct; vi.useRealTimers(); });

it("browse_detail_prepare_commit: actual ChatPagePanelHost uses separate detail, preparation and commit with disabled import result", async () => {
  const { api, getCatalog, enable } = await mount(); await market();
  expect(api.list).toHaveBeenCalledWith("firefly", false); expect(api.prepare).not.toHaveBeenCalled();
  await detail(); expect(api.detail).toHaveBeenCalledExactlyOnceWith("firefly", fixture().id);
  for (const value of ["Fixture bundle", "bundle-9", "Firefly-0423/firefly-skills", "skills/fixture", "a".repeat(40), "Not declared", "MIT", "LICENSE", "b".repeat(64), "SKILL.md", "200", "c".repeat(40), "d".repeat(64), "Instruction-only", "No blockers"]) expect(text()).toContain(value);
  expect(api.commit).not.toHaveBeenCalled(); await click(button("Prepare import"));
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith("firefly", fixture().id);
  const dialog = element.querySelector('[role="dialog"]'); expect(dialog?.textContent).toContain("f".repeat(64)); expect(dialog?.textContent).toContain("d".repeat(64));
  expect(api.commit).not.toHaveBeenCalled(); await click(button("Confirm import"));
  expect(api.commit).toHaveBeenCalledExactlyOnceWith("e".repeat(64)); expect(status()).toContain("Imported, not enabled"); expect(getCatalog).toHaveBeenCalledTimes(2); expect(enable).not.toHaveBeenCalled();
});
it("preview uses prepared inventory and digest rather than the earlier catalog or detail", async () => {
  const fresh = fixture(); fresh.files = [{ path: "references/prepared.txt", bytes: 777, blobSha1: "1".repeat(40), sha256: "2".repeat(64) }]; fresh.licenses[0].covers = ["references/prepared.txt"];
  await mount({ prepare: async () => ok(prepared(fresh)) }); await market(); await preview();
  const dialog = element.querySelector('[role="dialog"]')!; expect(dialog.textContent).toContain("references/prepared.txt"); expect(dialog.textContent).toContain("777"); expect(dialog.textContent).toContain("2".repeat(64)); expect(dialog.textContent).not.toContain("SKILL.md");
});
it("both sources remain browseable with blocked and unreviewed entries and searchable descriptions", async () => {
  const { api } = await mount({ list: async selected => ok([{ ...fixture("Fixture A", selected), review: "blocked", blockers: ["LICENSE_BLOCKED", "DEPENDENCY_BLOCKED"] }]), detail: async selected => ok({ ...fixture("Fixture A", selected), review: "unreviewed", blockers: ["LICENSE_BLOCKED", "DEPENDENCY_BLOCKED", "REVIEW_REQUIRED"] }) });
  await market(); await input("unmatched"); expect(text()).not.toContain("Fixture A"); await input("instruction"); expect(text()).toContain("Fixture A");
  await detail(); expect(text()).toContain("License"); expect(text()).toContain("dependencies"); expect(button("Prepare import").disabled).toBe(true); expect(api.prepare).not.toHaveBeenCalled();
  await click(button("Back to catalog")); await source("anthropic"); await detail(); expect(text()).toContain("anthropics/skills"); expect(text()).toContain("Review required");
});
it("safe_text_and_stale_responses: upstream HTML and image URLs render as escaped text only", async () => {
  const malicious = fixture('<img src="https://example.invalid/pixel" onerror="alert(1)">'); malicious.description = "<script>alert(1)</script> https://example.invalid/picture.png";
  await mount({ list: async () => ok([malicious]), detail: async () => ok(malicious) }); await market(); await detail(malicious.upstreamName);
  expect(text()).toContain(malicious.upstreamName); expect(text()).toContain(malicious.description); expect(element.querySelectorAll("img, script, iframe, a")).toHaveLength(0);
});
it("an obsolete source list cannot replace the newer selected source", async () => {
  const late = deferred<ExternalResult<ExternalSkill[]>>(); await mount({ list: selected => selected === "firefly" ? late.promise : Promise.resolve(ok([fixture("Fixture B", selected)])) }); await market(); await source("anthropic");
  expect(text()).toContain("Fixture B"); await act(async () => { late.resolve(ok([fixture()])); }); expect(text()).toContain("Fixture B"); expect(text()).not.toContain("Fixture A");
});
it("an obsolete detail cannot replace a newer candidate detail", async () => {
  const late = deferred<ExternalResult<ExternalSkill>>(); await mount({ list: async () => ok([fixture(), fixture("Fixture B")]), detail: (_selected, id) => id.endsWith("a") ? late.promise : Promise.resolve(ok(fixture("Fixture B"))) });
  await market(); await detail(); await click(button("Back to catalog")); await detail("Fixture B"); await act(async () => { late.resolve(ok(fixture())); });
  expect(element.querySelector('.external-skills__detail')?.textContent).toContain("Fixture B"); expect(element.querySelector('.external-skills__detail')?.textContent).not.toContain("Fixture A");
});
it.each(["back", "refresh", "source", "installed", "unmount"])("cancel and ignore late preparation on %s", async action => {
  const late = deferred<ExternalResult<ExternalPrepared>>(), cancel = vi.fn(async () => ok({ status: "cancelled" as const })); const { api } = await mount({ prepare: () => late.promise, cancel });
  await market(); await preview(); const before = cancel.mock.calls.length;
  if (action === "back") await click(button("Back to catalog"));
  if (action === "refresh") await click(button("Refresh catalog"));
  if (action === "source") await source("anthropic");
  if (action === "installed") await click(button("Installed"));
  if (action === "unmount") { await act(async () => { root!.unmount(); }); root = undefined; }
  expect(cancel.mock.calls.length).toBeGreaterThan(before); await act(async () => { late.resolve(ok(prepared(fixture()))); });
  expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(api.commit).not.toHaveBeenCalled();
});
it("late prepare A cannot open B confirmation and cancelled credentials are not reused", async () => {
  const late = deferred<ExternalResult<ExternalPrepared>>(); await mount({ list: async () => ok([fixture(), fixture("Fixture B")]), prepare: (_selected, id) => id.endsWith("a") ? late.promise : Promise.resolve(ok(prepared(fixture("Fixture B")))) });
  await market(); await preview(); await click(button("Back to catalog")); await preview("Fixture B");
  await act(async () => { late.resolve(ok(prepared(fixture()))); }); expect(element.querySelector('[role="dialog"]')?.textContent).toContain("Fixture B"); expect(element.querySelector('[role="dialog"]')?.textContent).not.toContain("Fixture A");
});
it("StrictMode remount ignores the old source generation and cancels on cleanup", async () => {
  const old = deferred<ExternalResult<ExternalSkill[]>>(); let calls = 0;
  const { api } = await mount({ list: async () => ++calls === 1 ? old.promise : ok([fixture("Fixture B")]) }, true); await market();
  // StrictMode also replays the newly mounted external panel's effects.
  expect(calls).toBe(2); expect(api.cancel).toHaveBeenCalled(); await act(async () => { old.resolve(ok([fixture()])); }); expect(text()).toContain("Fixture B"); expect(text()).not.toContain("Fixture A");
});
it("preview cancellation restores keyboard focus, sends cancel and never commits", async () => {
  const { api } = await mount(); await market(); await detail(); const opener = button("Prepare import"); opener.focus(); await click(opener);
  const dialog = element.querySelector<HTMLElement>('[role="dialog"]')!; expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(api.cancel).toHaveBeenCalled(); expect(api.commit).not.toHaveBeenCalled(); expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(button("Prepare import"));
});
it("native buttons accept keyboard-generated activation and the modal traps Tab", async () => {
  await mount(); await market(); await detail(); const opener = button("Prepare import"); expect(opener.type).toBe("button");
  await act(async () => { opener.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); });
  const dialog = element.querySelector<HTMLElement>('[role="dialog"]')!, confirm = button("Confirm import"); confirm.focus();
  await act(async () => { confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); }); expect(document.activeElement).toBe(button("Cancel")); expect(dialog.contains(document.activeElement)).toBe(true);
});
it("same-tick preparation and commit repeats send each mutation once; commit locks navigation until terminal result", async () => {
  const ready = deferred<ExternalResult<ExternalPrepared>>(), committed = deferred<ExternalResult<ExternalCommitted>>(); const { api } = await mount({ prepare: vi.fn(() => ready.promise), commit: vi.fn(() => committed.promise) });
  await market(); await detail(); const prepareButton = button("Prepare import"); await act(async () => { prepareButton.click(); prepareButton.click(); }); expect(api.prepare).toHaveBeenCalledTimes(1);
  await act(async () => { ready.resolve(ok(prepared(fixture()))); }); const confirm = button("Confirm import"); await act(async () => { confirm.click(); confirm.click(); }); expect(api.commit).toHaveBeenCalledTimes(1);
  for (const label of ["Cancel", "Back to catalog", "Refresh catalog", "anthropics/skills", "Installed"]) expect(button(label).disabled).toBe(true);
  const before = (api.cancel as ReturnType<typeof vi.fn>).mock.calls.length; await click(button("Cancel")); expect((api.cancel as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  expect(status()).not.toContain("Imported, not enabled"); await act(async () => { committed.resolve(ok({ id: fixture().id, enabled: false, contentSha256: "f".repeat(64) })); }); expect(status()).toContain("Fixture A"); expect(status()).toContain("Imported, not enabled"); expect(button("Installed").disabled).toBe(false);
});
it("commit failure stays on the accurate candidate and reports terminal error without false success", async () => {
  const { getCatalog } = await mount({ commit: async () => failure("STALE_SNAPSHOT") }); await market(); await preview(); await click(button("Confirm import"));
  expect(status()).toContain("STALE_SNAPSHOT"); expect(status()).not.toContain("Imported, not enabled"); expect(getCatalog).toHaveBeenCalledTimes(1); expect(button("Installed").disabled).toBe(false); expect(element.querySelector('[role="dialog"]')).toBeNull();
});
it("late commit on a destroyed Skills route cannot update a newer route or announce another candidate", async () => {
  const done = deferred<ExternalResult<ExternalCommitted>>(); const { getCatalog } = await mount({ commit: () => done.promise }); await market(); await preview(); await click(button("Confirm import"));
  await act(async () => { root!.render(React.createElement(ChatPagePanelHost, { panel: "tool" })); });
  await act(async () => { done.resolve(ok({ id: fixture().id, enabled: false, contentSha256: "f".repeat(64) })); }); expect(text()).toBe(""); expect(getCatalog).toHaveBeenCalledTimes(1);
});
it.each(["list", "detail", "prepare", "commit"])("rejected %s promise reports an error and does not fabricate success", async operation => {
  const { api } = await mount({ [operation]: async () => { throw new Error("fixture rejected promise"); } }); await market();
  if (operation !== "list") await detail(); if (operation === "prepare" || operation === "commit") await click(button("Prepare import")); if (operation === "commit") await click(button("Confirm import"));
  expect(status()).toContain("NETWORK_FAILED"); expect(status()).not.toContain("Imported, not enabled"); if (operation !== "commit") expect(api.commit).not.toHaveBeenCalled();
});
it("missing bridge is visible as unavailable rather than an empty marketplace", async () => {
  await mount(); window.settings!.externalSkills = undefined; await market(); expect(status()).toContain("unavailable"); expect(text()).not.toContain("No matching external skill");
});
it("expired preview credentials require fresh preparation", async () => {
  vi.useFakeTimers(); const { api } = await mount({ prepare: async () => ok({ ...prepared(fixture()), expiresAt: Date.now() + 10 }) }); await market(); await preview();
  await act(async () => { vi.advanceTimersByTime(11); }); expect(button("Confirm import").disabled).toBe(true); expect(status()).toContain("TOKEN_EXPIRED"); expect(api.commit).not.toHaveBeenCalled();
});
it.each(["prepared", "committed"])("mismatched %s identity cannot claim a successful import", async kind => {
  const { api } = await mount(kind === "prepared" ? { prepare: async () => ok(prepared(fixture("Fixture B"))) } : { commit: async () => ok({ id: fixture("Fixture B").id, enabled: false, contentSha256: "f".repeat(64) }) }); await market(); await preview();
  if (kind === "committed") await click(button("Confirm import")); else expect(api.commit).not.toHaveBeenCalled(); expect(status()).toContain("STATE_INVALID"); expect(status()).not.toContain("Imported, not enabled");
});
it("all new marketplace and enable copy is available in zh-CN and English", async () => {
  await mount(); await market(); await preview(); await act(async () => { setUiLocale("zh-CN"); }); expect(text()).toContain("确认导入"); expect(text()).toContain("未声明"); expect(text()).not.toMatch(/externalSkills\.[A-Za-z]/);
});

it("a late preview-cancel failure cannot overwrite a newer source's status", async () => {
  const cleanup = deferred<ExternalResult<{ status: "cancelled" | "idle" | "committing" }>>(); let cancels = 0;
  await mount({ cancel: () => ++cancels === 1 ? cleanup.promise : Promise.resolve(ok({ status: "idle" as const })) }); await market(); await preview(); await click(button("Cancel")); await source("anthropic"); await detail();
  await act(async () => { cleanup.resolve(failure()); }); expect(status()).not.toContain("NETWORK_FAILED"); expect(element.querySelector('.external-skills__detail')?.textContent).toContain("anthropics/skills");
});
it("same-tick host navigation after commit admission cannot hide the pending terminal result", async () => {
  const terminal = deferred<ExternalResult<ExternalCommitted>>(); await mount({ commit: () => terminal.promise }); await market(); await preview();
  const confirm = button("Confirm import"), installed = button("Installed");
  await act(async () => { confirm.click(); installed.click(); });
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain("Importing");
  await act(async () => { terminal.resolve(ok({ id: fixture().id, enabled: false, contentSha256: "f".repeat(64) })); }); expect(status()).toContain("Imported, not enabled");
});
it("the host's installed rescan cannot silently refresh an external preparation", async () => {
  await mount(); await market(); await preview();
  expect(element.querySelector<HTMLButtonElement>('button[title="Rescan user skills"]')?.disabled).toBe(true);
});
it("a new preparation waits for the prior preview cancellation to settle", async () => {
  const cleanup = deferred<ExternalResult<{ status: "cancelled" | "idle" | "committing" }>>(); const { api } = await mount({ cancel: () => cleanup.promise }); await market(); await preview();
  await click(button("Cancel")); await click(button("Prepare import")); expect(api.prepare).toHaveBeenCalledTimes(1);
  await act(async () => { cleanup.resolve(ok({ status: "cancelled" })); }); expect(api.prepare).toHaveBeenCalledTimes(2); expect(element.querySelector('[role="dialog"]')).not.toBeNull();
});
it("changing locale while a preview is open preserves the Main token and snapshot", async () => {
  const { api } = await mount(); await market(); await preview(); await act(async () => { setUiLocale("zh-CN"); }); await click(button("确认导入"));
  expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.commit).toHaveBeenCalledExactlyOnceWith("e".repeat(64)); expect(status()).toContain("已导入，未启用");
});

it("actual Skills route shows imported disabled entry and requires a separate explicit enable confirmation", async () => {
  const { enable } = await mount(); window.settings!.getSkillCatalog = async () => [{ id: fixture().id, name: "Fixture A", description: "Imported fixture", enabled: false, source: "user", modes: ["code", "work"], references: [] }];
  await market(); await preview(); await click(button("Confirm import")); await click(button("Installed"));
  expect(text()).toContain("Fixture A"); expect(text()).toContain("Disabled"); expect(element.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true); expect(enable).not.toHaveBeenCalled();
  await click(button("Enable")); expect(element.querySelector('[role="dialog"]')?.textContent).toContain("permissions"); await click(button("Confirm enable"));
  expect(enable).toHaveBeenCalledExactlyOnceWith(fixture().id, true); expect(text()).not.toContain("Disabled");
});
it("a rejected preview cancellation is reported without a false terminal import", async () => {
  await mount({ cancel: async () => { throw new Error("fixture cleanup failure"); } }); await market(); await preview(); await click(button("Cancel"));
  expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(status()).toContain("NETWORK_FAILED"); expect(status()).not.toContain("Imported, not enabled");
});
it("an installed-list refresh failure preserves the committed import's true disabled result", async () => {
  await mount(); window.settings!.getSkillCatalog = async () => { throw new Error("fixture list failure"); }; await market(); await preview(); await click(button("Confirm import"));
  expect(status()).toContain("Imported, not enabled"); expect(status()).toContain("installed list could not be refreshed"); expect(button("Installed").disabled).toBe(false);
});

it("locked commit moves focus off disabled confirmation controls and contains Tab until final focus return", async () => {
  const terminal = deferred<ExternalResult<ExternalCommitted>>(); const { api } = await mount({ commit: () => terminal.promise }); await market(); await preview();
  const dialog = element.querySelector<HTMLElement>('[role="dialog"]')!, confirm = button("Confirm import"), opener = button("Prepare import"); confirm.focus(); await click(confirm);
  expect(confirm.disabled).toBe(true); expect(button("Cancel").disabled).toBe(true); expect(document.activeElement).toBe(dialog);
  for (const shiftKey of [false, true]) {
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(tab); }); expect(tab.defaultPrevented).toBe(true); expect(document.activeElement).toBe(dialog);
  }
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(element.querySelector('[role="dialog"]')).toBe(dialog); expect(api.cancel).not.toHaveBeenCalled();
  // Deterministically model native focus falling outside when its old button becomes disabled.
  const outside = document.createElement("button"); document.body.append(outside);
  try { await act(async () => { outside.focus(); }); expect(document.activeElement).toBe(dialog); }
  finally { outside.remove(); }
  await act(async () => { terminal.resolve(ok({ id: fixture().id, enabled: false, contentSha256: "f".repeat(64) })); });
  expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener); expect(status()).toContain("Imported, not enabled");
});

it("loading catalog admits one same-source refresh even on repeated same-tick clicks", async () => {
  const late = deferred<ExternalResult<ExternalSkill[]>>(), list = vi.fn(() => late.promise);
  await mount({ list }); await market();
  const refresh = button("Refresh catalog"); expect(refresh.disabled).toBe(true);
  await act(async () => { refresh.click(); refresh.click(); button("Firefly-0423/firefly-skills").click(); });
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => late.resolve(ok([fixture()]))); expect(button("Refresh catalog").disabled).toBe(false);
});
it("rate-limited catalog has a waiting state and no automatic or repeated refresh calls", async () => {
  const retryAt = Date.now() + 120000, list = vi.fn(async () => ({ ok: false as const, code: "RATE_LIMITED" as const, error: "fixed", retryable: true, retryAt }));
  await mount({ list }); await market();
  expect(button("Refresh catalog").disabled).toBe(true); expect(button("anthropics/skills").disabled).toBe(true);
  expect(element.querySelector('[data-state="waiting"]')).not.toBeNull();
  await click(button("Refresh catalog")); expect(list).toHaveBeenCalledTimes(1);
});
it("catalog errors and empty results have separate visible states", async () => {
  const list = vi.fn(async () => failure()); await mount({ list }); await market();
  expect(element.querySelector('[data-state="error"]')?.textContent).toContain("NETWORK_FAILED");
  list.mockImplementation(async () => ok([])); await click(button("Refresh catalog"));
  expect(element.querySelector('[data-state="empty"]')).not.toBeNull(); expect(element.querySelector('[data-state="error"]')).toBeNull();
});

it.each(["detail", "prepare"] as const)("cached_catalog_waiting remains explained after %s rate limit and Back", async step => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const retryAt = Date.now() + 120000, limited = { ok: false as const, code: "RATE_LIMITED" as const, error: "fixed", retryable: true, retryAt };
  const list = vi.fn(async () => ok([fixture()]));
  const { api } = await mount({ list, ...(step === "detail" ? { detail: async () => limited } : { prepare: async () => limited }) });
  await market(); await detail(); if (step === "prepare") await click(button("Prepare import"));
  expect(element.querySelector('[data-state="waiting"]')).not.toBeNull();
  await click(button("Back to catalog")); expect(list).toHaveBeenCalledTimes(2);
  const waiting = element.querySelector('[data-state="waiting"]'); expect(waiting).not.toBeNull(); expect(waiting?.textContent).toContain("120");
  await act(async () => { setUiLocale("zh-CN"); }); expect(status()).toContain("120 秒");
  await act(async () => { setUiLocale("en"); });
  expect(button("Refresh catalog").disabled).toBe(true); expect(button("Fixture A").disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(element.querySelector('[data-state="waiting"]')).toBeNull(); expect(button("Refresh catalog").disabled).toBe(false);
  expect(list).toHaveBeenCalledTimes(2); expect(api.commit).not.toHaveBeenCalled();
});

const lightweight = () => ({ ...fixture(), declaration: "verified" as const, review: "unreviewed" as const, blockers: ["REVIEW_REQUIRED" as const], files: [], licenses: [],
  preview: { complete: false as const, files: 35, bytes: 12345, licenseFiles: [{ path: "skills/fixture/LICENSE", bytes: 1024, blobSha1: "b".repeat(40) }] } });
it("lightweight_preview visibly remains incomplete and waits for full prepare before showing audited import confirmation", async () => {
  const { api, enable } = await mount({ detail: async () => ok(lightweight()) }); await market(); await detail();
  expect(text()).toContain("Full content has not been reviewed"); expect(text()).toContain("35"); expect(text()).toContain("12345"); expect(text()).toContain("skills/fixture/LICENSE");
  expect(text()).not.toContain("Instruction-only"); expect(text()).not.toContain("SHA-256:");
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.commit).not.toHaveBeenCalled(); expect(enable).not.toHaveBeenCalled();
  await click(button("Review full content")); expect(api.prepare).toHaveBeenCalledExactlyOnceWith("firefly", fixture().id);
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain("d".repeat(64));
  expect(api.commit).not.toHaveBeenCalled(); await click(button("Confirm import")); expect(api.commit).toHaveBeenCalledOnce(); expect(enable).not.toHaveBeenCalled();
});
it("lightweight_preview is rejected as prepared approval even if its review label is forged to approved", async () => {
  const forged = { ...lightweight(), review: "approved" as const, blockers: [] };
  const { api } = await mount({ detail: async () => ok(lightweight()), prepare: async () => ok(prepared(forged)) }); await market(); await detail(); await click(button("Review full content"));
  expect(status()).toContain("STATE_INVALID"); expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(api.commit).not.toHaveBeenCalled();
});
it("lightweight_preview cannot start preparation with a blocked declaration or other known blocker", async () => {
  const { api } = await mount({ detail: async () => ok({ ...lightweight(), blockers: ["REVIEW_REQUIRED", "DEPENDENCY_BLOCKED"] }) }); await market(); await detail();
  expect(button("Review full content").disabled).toBe(true); expect(api.prepare).not.toHaveBeenCalled();
});

it("failed full review replaces the actionable preview with Main's known dependency blockers", async () => {
  let reads = 0;
  const { api } = await mount({ detail: async () => ok(++reads === 1 ? lightweight() : { ...lightweight(), blockers: ["DEPENDENCY_BLOCKED", "REVIEW_REQUIRED"] }), prepare: async () => failure("DEPENDENCY_BLOCKED") });
  await market(); await detail(); await click(button("Review full content"));
  expect(button("Review full content").disabled).toBe(true);
  expect(element.querySelector(".external-skills__inventory dl")?.textContent).toContain("Unsupported dependencies");
  expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(api.commit).not.toHaveBeenCalled();
});

it("a failed post-review detail read removes the stale actionable preview", async () => {
  let reads = 0;
  await mount({ detail: async () => ++reads === 1 ? ok(lightweight()) : failure(), prepare: async () => failure("DEPENDENCY_BLOCKED") });
  await market(); await detail(); await click(button("Review full content"));
  expect(element.querySelector(".external-skills__detail")).toBeNull();
  expect(status()).toContain("DEPENDENCY_BLOCKED"); expect(status()).toContain("NETWORK_FAILED");
});

it("late post-review detail cannot overwrite the newer source's selected skill", async () => {
  const late = deferred<ExternalResult<ExternalSkill>>(); let reads = 0;
  await mount({ list: async selected => ok([fixture(selected === "anthropic" ? "Fixture B" : "Fixture A", selected)]),
    detail: async selected => selected === "anthropic" ? ok(fixture("Fixture B", selected)) : ++reads === 1 ? ok(lightweight()) : late.promise,
    prepare: async () => failure("DEPENDENCY_BLOCKED") });
  await market(); await detail(); await click(button("Review full content"));
  expect(element.querySelector(".external-skills__detail")).toBeNull();
  await source("anthropic"); await detail("Fixture B");
  await act(async () => { late.resolve(ok({ ...lightweight(), blockers: ["DEPENDENCY_BLOCKED", "REVIEW_REQUIRED"] })); });
  expect(element.querySelector(".external-skills__detail")?.textContent).toContain("Fixture B");
  expect(element.querySelector(".external-skills__detail")?.textContent).toContain("anthropics/skills");
  expect(status()).not.toContain("DEPENDENCY_BLOCKED");
});

it("a prepared response for a different fixed commit cannot open import confirmation", async () => {
  const { api } = await mount({ prepare: async () => ok(prepared({ ...fixture(), commit: "b".repeat(40) })) });
  await market(); await preview();
  expect(status()).toContain("STATE_INVALID"); expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(api.commit).not.toHaveBeenCalled();
});

it("a detail response for a different fixed commit cannot replace the catalog identity", async () => {
  await mount({ detail: async () => ok({ ...fixture(), commit: "b".repeat(40) }) });
  await market(); await detail();
  expect(status()).toContain("STATE_INVALID"); expect(element.querySelector(".external-skills__detail")).toBeNull();
});

it("the external market describes Work and Code availability independently of the installed Code tab", async () => {
  await mount(); await market();
  expect(element.querySelector(".skill-panel__subtitle")?.textContent).toContain("Work and Code");
  expect(element.querySelector(".skill-panel__subtitle")?.textContent).toContain("separate confirmation");
});

const revisioned = () => ({ ...fixture(), commit: "c".repeat(40), selection: { kind: "latest" as const, commit: "c".repeat(40) },
  revisions: { latest: { commit: "c".repeat(40) }, reviewed: { commit: "a".repeat(40), contentSha256: "f".repeat(64), policyVersion: "firefly-instruction-only-v1", reviewedAt: "2026-10-08T00:00:00.000Z" },
    installed: { commit: "b".repeat(40), contentSha256: "1".repeat(64), enabled: false } } });
const reviewedPreview = () => ({ ...lightweight(), selection: { kind: "reviewed" as const, commit: "a".repeat(40) }, revisions: revisioned().revisions });

it("reviewed snapshot can be selected independently of latest and installed identities", async () => {
  const latest = revisioned();
  const { api } = await mount({ list: async () => ok([latest]),
    detail: async (_selected, _id, selection = latest.selection) => ok(selection.kind === "reviewed" ? reviewedPreview() : { ...latest, ...lightweight(), commit: latest.commit, selection: latest.selection }),
    prepare: vi.fn(async () => ok(prepared({ ...fixture(), selection: reviewedPreview().selection, revisions: latest.revisions }))) });
  await market(); await detail();
  for (const label of ["Latest discovered", "Reviewed snapshot", "Installed version"]) expect(text()).toContain(label);
  await click(button("Reviewed snapshot"));
  expect(element.querySelector(".external-skills__detail dl")?.textContent).toContain("firefly-instruction-only-v1");
  await click(button("Review full content"));
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith("firefly", fixture().id, { kind: "reviewed", commit: "a".repeat(40) });
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain("a".repeat(40));
});

it("switching revision cancels an old preparation and ignores its late confirmation", async () => {
  const latest = revisioned(), late = deferred<ExternalResult<ExternalPrepared>>();
  await mount({ list: async () => ok([latest]),
    detail: async (_source, _id, selection = latest.selection) => ok(selection.kind === "reviewed" ? reviewedPreview() : { ...latest, ...lightweight(), commit: latest.commit, selection: latest.selection }),
    prepare: () => late.promise });
  await market(); await detail(); await click(button("Review full content")); await click(button("Reviewed snapshot"));
  await act(async () => { late.resolve(ok(prepared(latest))); });
  expect(element.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Reviewed snapshot").getAttribute("aria-pressed")).toBe("true");
});

it("unsupported component and file evidence is visible as escaped text without granting import", async () => {
  await mount({ detail: async () => ok({ ...lightweight(), blockers: ["DEPENDENCY_BLOCKED", "REVIEW_REQUIRED"], compatibilityFormat: "codex",
    dependencyIssues: [{ kind: "component", path: "plugins/bundle/.codex-plugin/plugin.json", component: "mcpServers" }, { kind: "file", path: "plugins/bundle/skills/text/scripts/render.mjs" }] }) });
  await market(); await detail();
  expect(text()).toContain("plugins/bundle/.codex-plugin/plugin.json"); expect(text()).toContain("mcpServers"); expect(text()).toContain("scripts/render.mjs");
  expect(button("Review full content").disabled).toBe(true); expect(element.querySelectorAll("script, iframe, img, a")).toHaveLength(0);
});
it("built_in: a market skill Firefly already ships is labelled built in and cannot be prepared", async () => {
  const shipped = { ...fixture(), review: "unreviewed" as const, blockers: ["REVIEW_REQUIRED" as const], builtIn: true as const };
  const { api } = await mount({ list: async () => ok([shipped]), detail: async () => ok(shipped) }); await market();
  expect(text()).toContain("Built in");
  expect(element.querySelector(".external-skills__catalog")?.textContent).not.toContain("REVIEW_REQUIRED");
  await detail(); expect(text()).toContain("Firefly already ships this skill");
  expect(button("Prepare import").disabled).toBe(true);
  await click(button("Prepare import")); expect(api.prepare).not.toHaveBeenCalled();
});
