// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import SkillModePanel from "./SkillModePanel";
import { setUiLocale } from "../../../i18n";

let root: Root | undefined;
let element: HTMLDivElement;
const originalSettings = window.settings;
const originalActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function mount(
  save?: (skillId: string, mode: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>,
  options: { strict?: boolean; getOverrides?: () => Promise<Record<string, { code?: boolean; work?: boolean }>>; enabled?: boolean; enable?: (id: string, enabled: boolean) => Promise<{ ok: boolean }> } = {},
) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const rescan = vi.fn(async () => ({ ok: true, count: 1 }));
  window.settings = {
    getSkillCatalog: async () => [{ id: "fixture-skill", name: "Fixture", description: "Synthetic Skill", enabled: options.enabled ?? true, source: "builtin", modes: ["work", "code"], references: [] }],
    getSkillModeOverrides: options.getOverrides ?? (async () => ({})), setSkillModeOverride: save, rescanSkills: rescan,
    setSkillEnabled: options.enable,
  } as any;
  element = document.createElement("div"); document.body.append(element);
  root = createRoot(element);
  await act(async () => {
    const panel = React.createElement(SkillModePanel);
    root!.render(options.strict ? React.createElement(React.StrictMode, null, panel) : panel);
  });
  return { rescan };
}
const toggle = () => element.querySelector<HTMLButtonElement>('[role="switch"]')!;
const status = () => element.querySelector('[role="status"]')?.textContent ?? "";
async function click(node: HTMLElement) { await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); }
async function mode(name: string) { await click([...element.querySelectorAll<HTMLButtonElement>(".ff-panel-sidebar__item")].find(button => button.textContent === name)!); }
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; element?.remove(); window.settings = originalSettings;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  setUiLocale("zh-CN");
});

it.each(["rejected-result", "rejected-promise", "missing-bridge"])("restores the confirmed mode and shows failure after %s", async failure => {
  const save = failure === "missing-bridge" ? undefined : async () => {
    if (failure === "rejected-promise") throw new Error("synthetic write failure");
    return { ok: false, error: "synthetic write failure" };
  };
  await mount(save); expect(toggle().getAttribute("aria-checked")).toBe("true");
  await click(toggle());
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(status()).toContain("fixture-skill"); expect(status()).toContain("Code");
  expect(status()).toContain("保存"); expect(toggle().disabled).toBe(false);
});

it("keeps a confirmed successful save and allows a later reversal", async () => {
  const save = vi.fn(async () => ({ ok: true })); await mount(save);
  await click(toggle()); expect(toggle().getAttribute("aria-checked")).toBe("false");
  await click(toggle()); expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(save.mock.calls).toHaveLength(2); expect(status()).toBe("");
});

it("admits only one pending save per Skill and mode even for same-tick clicks", async () => {
  const pending = deferred<{ ok: boolean }>(); const save = vi.fn(() => pending.promise);
  const { rescan } = await mount(save); const button = toggle();
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(save).toHaveBeenCalledTimes(1); expect(toggle().disabled).toBe(true);
  const refresh = element.querySelector<HTMLButtonElement>(".ff-panel-iconbtn")!;
  expect(refresh.disabled).toBe(true); await click(refresh); expect(rescan).not.toHaveBeenCalled();
  await act(async () => { pending.resolve({ ok: false }); });
  expect(toggle().getAttribute("aria-checked")).toBe("true"); expect(toggle().disabled).toBe(false);
});

it("a late Code failure cannot roll back a newer successful Work save", async () => {
  const code = deferred<{ ok: boolean }>(), work = deferred<{ ok: boolean }>();
  await mount(async (_id, selectedMode) => selectedMode === "code" ? code.promise : work.promise);
  await click(toggle()); await mode("Work"); expect(toggle().disabled).toBe(false);
  await click(toggle());
  await act(async () => { work.resolve({ ok: true }); });
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => { code.resolve({ ok: false }); });
  expect(toggle().getAttribute("aria-checked")).toBe("false"); expect(status()).toContain("Code");
  await mode("Code"); expect(toggle().getAttribute("aria-checked")).toBe("true");
});

it("clears only the retried failure once that same mode saves successfully", async () => {
  let accepted = false; await mount(async () => ({ ok: accepted }));
  await click(toggle()); expect(status()).toContain("Code");
  accepted = true; await click(toggle());
  expect(toggle().getAttribute("aria-checked")).toBe("false"); expect(status()).toBe("");
});

it.each(["save", "rescan"])("ignores an obsolete StrictMode load after a newer %s", async operation => {
  const obsolete = deferred<Record<string, { code?: boolean }>>();
  let reads = 0;
  await mount(async () => ({ ok: true }), { strict: true, getOverrides: async () => {
    if (++reads === 1) return obsolete.promise;
    return reads === 2 ? {} : { "fixture-skill": { code: false } };
  } });
  expect(reads).toBe(2); expect(toggle().getAttribute("aria-checked")).toBe("true");
  if (operation === "save") await click(toggle());
  else await click(element.querySelector<HTMLButtonElement>(".ff-panel-iconbtn")!);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => { obsolete.resolve({}); });
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});

const namedButton = (name: string) => { const found = [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === name); expect(found, `Missing accessible button: ${name}`).toBeDefined(); return found!; };
it("disabled_is_visible: global enable is explicit, cancellable and persistence-first", async () => {
  setUiLocale("en");
  const pending = deferred<{ ok: boolean }>(), enable = vi.fn(() => pending.promise), save = vi.fn(async () => ({ ok: true }));
  await mount(save, { enabled: false, enable });
  expect(element.textContent).toContain("Fixture"); expect(element.textContent).toContain("Disabled");
  expect(toggle().disabled).toBe(true); expect(toggle().getAttribute("aria-checked")).toBe("false");
  const opener = namedButton("Enable"); opener.focus(); await click(opener);
  const dialog = element.querySelector('[role="dialog"]'); expect(dialog?.textContent).toContain("third-party instructions"); expect(dialog?.textContent).toContain("permissions");
  await click(namedButton("Cancel")); expect(enable).not.toHaveBeenCalled(); expect(document.activeElement).toBe(opener);
  await click(opener); const confirm = namedButton("Confirm enable");
  await act(async () => { confirm.click(); confirm.click(); });
  expect(enable).toHaveBeenCalledExactlyOnceWith("fixture-skill", true); expect(save).not.toHaveBeenCalled();
  expect(element.textContent).toContain("Disabled");
  await act(async () => { pending.resolve({ ok: true }); });
  expect(element.textContent).not.toContain("Disabled"); expect(toggle().disabled).toBe(false);
});

it.each(["result", "promise", "bridge"])("disabled_is_visible: stays disabled after enable %s failure", async failure => {
  setUiLocale("en");
  const enable = failure === "bridge" ? undefined : async () => { if (failure === "promise") throw new Error("fixture"); return { ok: false }; };
  await mount(async () => ({ ok: true }), { enabled: false, enable });
  await click(namedButton("Enable")); await click(namedButton("Confirm enable"));
  expect(element.textContent).toContain("Disabled"); expect(toggle().disabled).toBe(true); expect(status()).toContain("Could not enable");
});

it.each([true, false])("locked enable keeps focus and Tab in the dialog until its %s terminal result", async accepted => {
  setUiLocale("en"); const pending = deferred<{ ok: boolean }>(), enable = vi.fn(() => pending.promise);
  await mount(async () => ({ ok: true }), { enabled: false, enable }); const opener = namedButton("Enable"); opener.focus(); await click(opener);
  const dialog = element.querySelector<HTMLElement>('[role="dialog"]')!, confirm = namedButton("Confirm enable"); confirm.focus(); await click(confirm);
  expect(confirm.disabled).toBe(true); expect(namedButton("Cancel").disabled).toBe(true); expect(document.activeElement).toBe(dialog);
  for (const shiftKey of [false, true]) {
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(tab); }); expect(tab.defaultPrevented).toBe(true); expect(document.activeElement).toBe(dialog);
  }
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(element.querySelector('[role="dialog"]')).toBe(dialog);
  const outside = document.createElement("button"); document.body.append(outside);
  try { await act(async () => { outside.focus(); }); expect(document.activeElement).toBe(dialog); }
  finally { outside.remove(); }
  await act(async () => { pending.resolve({ ok: accepted }); });
  expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(accepted ? toggle() : opener);
  expect(toggle().disabled).toBe(!accepted); expect(enable).toHaveBeenCalledExactlyOnceWith("fixture-skill", true);
  if (accepted) expect(element.textContent).not.toContain("Disabled"); else expect(status()).toContain("Could not enable");
});

it("translates descriptions that have no Chinese once on opening, then shows the Chinese text", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const translateSkillDescriptions = vi.fn(async () => ({ ok: true, translated: { "fixture-skill": "合成的测试技能" } }));
  window.settings = {
    getSkillCatalog: async () => [
      { id: "fixture-skill", name: "Fixture", description: "Synthetic Skill", enabled: true, source: "builtin", modes: ["work", "code"], references: [] },
      { id: "known", name: "Known", description: "Already done", descriptionZh: "已经翻译过", enabled: true, source: "user", modes: null, references: [] },
    ],
    getSkillModeOverrides: async () => ({}), translateSkillDescriptions,
  } as any;
  element = document.createElement("div"); document.body.append(element);
  root = createRoot(element);
  await act(async () => { root!.render(React.createElement(SkillModePanel)); });
  await act(async () => { await Promise.resolve(); });
  expect(translateSkillDescriptions).toHaveBeenCalledOnce();
  const descriptions = [...element.querySelectorAll(".skill-card__desc")].map(node => node.textContent);
  expect(descriptions).toEqual(["合成的测试技能", "已经翻译过"]);
});

it("does not ask for a translation when every description already has Chinese", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const translateSkillDescriptions = vi.fn(async () => ({ ok: true, translated: {} }));
  window.settings = {
    getSkillCatalog: async () => [{ id: "known", name: "Known", description: "Done", descriptionZh: "完成", enabled: true, source: "user", modes: null, references: [] }],
    getSkillModeOverrides: async () => ({}), translateSkillDescriptions,
  } as any;
  element = document.createElement("div"); document.body.append(element);
  root = createRoot(element);
  await act(async () => { root!.render(React.createElement(SkillModePanel)); });
  expect(translateSkillDescriptions).not.toHaveBeenCalled();
});
