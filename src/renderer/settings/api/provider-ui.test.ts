// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withTypeScale } from "../../../test-utils/type-scale";
import { renderProviderRows } from "./provider-rows";
import { applyProviderEditorLayout, mountProfileEditor, renderKeepingProfileEditor } from "./provider-editor";
import type { SavedProfileLite } from "./state";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../custom-endpoint-state";
import { applyTranslations, setLocale, t } from "../i18n";

const html = fs.readFileSync(path.resolve("src/renderer/settings/index.html"), "utf8");
afterEach(() => setLocale("zh-CN"));
const profile = (id: string, fields: Partial<SavedProfileLite> = {}): SavedProfileLite => ({
  id, provider: "DeepSeek（深度求索）", displayName: "Saved model", model: "saved-model",
  baseUrl: "https://private.example/v1?secret=value", apiKey: "private-key", ...fields,
});

it("shows compact edit/delete rows and configuration state without claiming connectivity or exposing credentials", () => {
  const root = document.createElement("div");
  renderProviderRows(root, [profile("first"), profile("second", { apiKey: "" }), profile("local", { provider: CUSTOM_ENDPOINT_PROVIDERS.local, apiKey: "" })], "first");
  expect(root.querySelectorAll(".provider-row")).toHaveLength(3);
  expect(root.querySelectorAll('[data-profile-action="edit"]')).toHaveLength(3);
  expect(root.querySelectorAll('[data-profile-action="delete"]')).toHaveLength(3);
  expect(root.textContent).toContain("未验证连接");
  expect(root.textContent).toContain("缺少 API Key");
  expect(root.textContent).not.toMatch(/private-key|private\.example|secret=value/);
});

it("starts with a closed add/edit form, and the role overrides live on the sub-agents page instead of the API page", () => {
  document.body.innerHTML = html;
  expect(document.getElementById("profile-editor")?.hidden).toBe(true);
  expect(document.querySelectorAll('[data-provider-tab]')).toHaveLength(2);
  expect(document.getElementById("agent-routing-group")).toBeNull();
  expect(document.getElementById("api-form")?.contains(document.getElementById("agent-routing-panel"))).toBe(false);
  expect(document.getElementById("subagents-panel")?.contains(document.getElementById("agent-routing-panel"))).toBe(true);
});

it("relocates original field nodes without changing their values", () => {
  document.body.innerHTML = html;
  const root = document.getElementById("api-form")!;
  const model = document.getElementById("model-input") as HTMLInputElement;
  model.value = "manual-model-id";
  applyProviderEditorLayout(root, "preset");
  // 预设：昵称 / Base URL / 协议收进“自定义设置”，API Key 与模型名始终可见。
  expect(document.getElementById("display-name")?.closest("details")?.id).toBe("provider-connection-more");
  expect(document.getElementById("transport-select")?.closest("details")?.id).toBe("provider-connection-more");
  expect(document.getElementById("api-key")?.closest("details")).toBeNull();
  expect(model.closest("details")).toBeNull();
  expect(model.closest("#provider-model-fields")).not.toBeNull();
  expect((document.getElementById("provider-connection-more") as HTMLElement).hidden).toBe(false);
  applyProviderEditorLayout(root, "custom");
  expect(document.getElementById("model-input")).toBe(model);
  expect(model.closest("details")).toBeNull();
  expect(model.value).toBe("manual-model-id");
  expect(document.getElementById("transport-select")?.closest("details")).toBeNull();
  expect(document.getElementById("base-url")?.closest("#provider-primary-fields")).not.toBeNull();
  expect((document.getElementById("provider-connection-more") as HTMLElement).hidden).toBe(true);
  expect(root.querySelector('[data-provider-tab="custom"]')?.getAttribute("aria-selected")).toBe("true");
});

it("resolves new labels, tabs, configuration state and actions in English", () => {
  setLocale("en");
  document.body.innerHTML = html;
  applyTranslations(document.body);
  expect(t("settings.providerUi.addTitle")).toBe("Add model provider");
  expect(document.querySelector('[data-provider-tab="custom"]')?.textContent).toBe("Custom model API");
  expect(document.getElementById("add-profile-btn")?.textContent).toBe("Add model provider");
  expect(document.querySelector('[data-i18n="settings.providerUi.listTitle"]')?.textContent).toBe("Configured model providers");
  expect(document.querySelector('[data-i18n="settings.providerUi.listSubtitle"]')?.textContent).toBe("Each configuration uses one model. Status describes saved configuration only.");
  const root = document.createElement("div");
  renderProviderRows(root, [profile("first")]);
  expect(root.textContent).toContain("Configured · Connection not tested");
  expect(root.querySelector('[data-profile-action="edit"]')?.getAttribute("aria-label")).toBe("Edit Saved model");
  expect(root.querySelector('[data-profile-action="delete"]')?.textContent).toBe("Delete");
});

it("offers the input type as an automatic, image, or text-only choice inside the advanced section, and no multimodal switch", () => {
  document.body.innerHTML = html;
  const editor = document.getElementById("profile-editor")!;
  const choices = [...document.querySelectorAll<HTMLButtonElement>("#input-modalities-select .option-block")];
  expect(choices.map(button => button.dataset.value)).toEqual(["auto", "image", "text"]);
  expect(choices.find(button => button.dataset.value === "auto")?.getAttribute("aria-pressed")).toBe("true");
  expect(document.getElementById("provider-advanced")!.contains(document.getElementById("input-modalities-hint"))).toBe(true);
  expect(editor.textContent).not.toMatch(/多模态|profile-multimodal/);
  expect(editor.querySelector('[id*="multimodal"]')).toBeNull();
});

it("does not expose the retired standalone status-panel control", () => {
  document.body.innerHTML = html;
  expect(document.getElementById("sidebar-visible")).toBeNull();
  expect(document.getElementById("general-save-status")).toBeNull();
});

it("lists profiles as one column of cards with an add button below, and keeps routing outside the editor", () => {
  document.body.innerHTML = html;
  const board = document.querySelector(".provider-board")!;
  expect(board).not.toBeNull();
  expect(board.contains(document.getElementById("model-profile-list"))).toBe(true);
  expect(board.contains(document.getElementById("add-profile-btn"))).toBe(true);
  expect(board.contains(document.getElementById("profile-editor"))).toBe(true);
  expect(document.querySelector(".model-settings-workspace, .model-settings-sidebar, .model-settings-detail")).toBeNull();
  expect(document.getElementById("profile-editor-empty")).toBeNull();
  expect(document.getElementById("profile-editor")?.contains(document.getElementById("agent-routing-panel"))).toBe(false);
});

it("groups the editor into connection, model and a collapsed advanced section, with footer actions in order", () => {
  document.body.innerHTML = html;
  const editor = document.getElementById("profile-editor")!;
  const sections = [...editor.querySelectorAll<HTMLElement>(".provider-section")].map(section => section.getAttribute("aria-labelledby"));
  expect(sections).toEqual(["provider-section-connection", "provider-section-model"]);
  expect(document.getElementById("provider-section-connection")!.closest("section")!.contains(document.getElementById("api-key"))).toBe(true);
  const model = document.getElementById("provider-section-model")!.closest("section")!;
  for (const id of ["model-input", "fetch-models-btn", "fetch-models-picker", "context-window-input", "reasoning-levels-auto"]) {
    expect(model.contains(document.getElementById(id)), id).toBe(true);
  }
  const advanced = document.getElementById("provider-advanced") as HTMLDetailsElement;
  expect(advanced.open).toBe(false);
  // Taken off the page; its fields stay in the DOM so saved values still load and save.
  expect(advanced.hidden).toBe(true);
  for (const id of ["input-modalities-select", "timeout-test", "custom-endpoint-overrides"]) {
    expect(advanced.contains(document.getElementById(id)), id).toBe(true);
  }
  expect(model.contains(document.getElementById("input-modalities-select"))).toBe(false);
  const footer = [...editor.querySelectorAll<HTMLButtonElement>(".provider-editor__footer button")].map(button => button.id || button.type);
  expect(footer).toEqual(["delete-profile-btn", "close-profile-editor", "test-connection-btn", "submit"]);
});

it("keeps the editor inside the selected card across list redraws and parks it when no card matches", () => {
  document.body.innerHTML = html;
  const form = document.getElementById("api-form")!;
  const list = document.getElementById("model-profile-list")!;
  const editor = document.getElementById("profile-editor")!;
  const key = document.getElementById("api-key") as HTMLInputElement;
  key.value = "draft-survives";
  const draw = () => renderProviderRows(list, [profile("first"), profile("second")], "first", "second");
  renderKeepingProfileEditor(form, "second", draw);
  expect(editor.parentElement).toBe(list.querySelector('[data-profile-id="second"]'));
  expect(editor.parentElement?.lastElementChild).toBe(editor);
  renderKeepingProfileEditor(form, "second", draw);
  expect(editor.parentElement).toBe(list.querySelector('[data-profile-id="second"]'));
  expect(key.value).toBe("draft-survives");
  mountProfileEditor(form, undefined);
  expect(editor.parentElement).toBe(document.getElementById("provider-editor-slot"));
  renderKeepingProfileEditor(form, "missing", draw);
  expect(editor.parentElement).toBe(document.getElementById("provider-editor-slot"));
  expect(document.contains(editor)).toBe(true);
});

it("restores focus inside the editor after it moves between cards", () => {
  document.body.innerHTML = html;
  const form = document.getElementById("api-form")!;
  const list = document.getElementById("model-profile-list")!;
  const draw = () => renderProviderRows(list, [profile("first"), profile("second")]);
  renderKeepingProfileEditor(form, "first", draw);
  const key = document.getElementById("api-key") as HTMLInputElement;
  key.focus();
  expect(document.activeElement).toBe(key);
  renderKeepingProfileEditor(form, "second", draw);
  expect(document.activeElement).toBe(key);
});

it("marks custom and default profiles with tags and flags missing credentials with a red status dot", () => {
  const root = document.createElement("div");
  renderProviderRows(root, [profile("a"), profile("b", { apiKey: "", provider: CUSTOM_ENDPOINT_PROVIDERS.cloud })], "a");
  const first = root.querySelector('[data-profile-id="a"]')!;
  const second = root.querySelector('[data-profile-id="b"]')!;
  expect(first.querySelector(".provider-row__tag--default")?.textContent).toBe("默认");
  expect(first.querySelector(".provider-row__dot")?.getAttribute("data-state")).toBe("ok");
  expect(first.querySelector(".provider-row__tag:not(.provider-row__tag--default)")).toBeNull();
  expect(second.querySelector(".provider-row__tag")?.textContent).toBe("自定义");
  expect(second.querySelector(".provider-row__dot")?.getAttribute("data-state")).toBe("missing");
  expect(first.querySelector(".provider-row__head")?.contains(first.querySelector('[data-profile-action="delete"]'))).toBe(true);
});

it("marks only the selected profile and makes the full profile summary a navigation button", () => {
  const root = document.createElement('div');
  renderProviderRows(root, [profile('first'), profile('second')], 'first', 'second');
  const selected = root.querySelector('[data-profile-id="second"] [data-profile-action="edit"]')!;
  expect(selected.getAttribute('aria-current')).toBe('true');
  expect(selected.textContent).toContain('Saved model');
  expect(root.querySelector('[data-profile-id="first"] [data-profile-action="edit"]')?.hasAttribute('aria-current')).toBe(false);
});

it("styles profiles as a single column of 16px cards with a dashed add button", () => {
  const css = fs.readFileSync(path.resolve('src/renderer/settings/settings-api.css'), 'utf8');
  expect(css).toMatch(/--api-card-radius:\s*16px/);
  expect(css).toMatch(/#api-form #model-profile-list\s*\{[^}]*flex-direction:\s*column/);
  expect(css).toMatch(/#api-form \.provider-row\s*\{[^}]*border-radius:\s*var\(--api-card-radius\)/);
  expect(css).toMatch(/#api-form \.provider-add\s*\{[^}]*border:\s*1px dashed/);
  expect(css).not.toMatch(/model-settings-(workspace|sidebar|detail)/);
  // 旧的左右分栏工作区样式已移除，不应再留在通用样式表里。
  for (const file of ["settings-layout.css", "settings.css"]) {
    const legacy = fs.readFileSync(path.resolve("src/renderer/settings", file), "utf8");
    expect(legacy, file).not.toMatch(/model-settings-(workspace|sidebar|detail)|provider-list__tools|provider-editor-empty|provider-editor__toolbar|profile-list-(section|heading)/);
  }
});

it("marks the card whose editor is open as expanded", () => {
  const root = document.createElement("div");
  renderProviderRows(root, [profile("first"), profile("second")], "first", "second");
  expect(root.querySelector('[data-profile-id="second"] [data-profile-action="edit"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(root.querySelector('[data-profile-id="first"] [data-profile-action="edit"]')?.getAttribute("aria-expanded")).toBe("false");
});

it("lets protocol labels wrap inside the narrower editor column", () => {
  document.body.innerHTML = html;
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.resolve('src/renderer/settings/settings.css'), 'utf8') + '\n' + fs.readFileSync(path.resolve('src/renderer/settings/settings-api.css'), 'utf8');
  document.head.append(style);
  expect(getComputedStyle(document.querySelector('.transport-cards .preset-card__name')!).whiteSpace).toBe('normal');
  style.remove();
});

it("keeps profile card controls on the rounded-corner contract (10px small buttons, 10px copy focus ring)", () => {
  document.body.innerHTML = html;
  const style = document.createElement("style");
  style.textContent = fs.readFileSync(path.resolve("src/renderer/settings/settings-api.css"), "utf8");
  document.head.append(style);
  try {
    const root = document.getElementById("model-profile-list")!;
    renderProviderRows(root, [profile("first")]);
    for (const selector of [".provider-row__copy", ".provider-row__chip", ".provider-row__action"]) {
      expect.soft(getComputedStyle(root.querySelector(selector)!).borderRadius, selector).toBe("10px");
    }
  } finally {
    style.remove();
  }
});


it("associates the profile selection with its model and saved configuration status", () => {
  const root = document.createElement("div");
  renderProviderRows(root, [profile("first"), profile("second", { apiKey: "" })]);
  for (const copy of root.querySelectorAll('[data-profile-action="edit"]')) {
    const ids = copy.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids).toHaveLength(2);
    const descriptions = ids.map(id => root.querySelector(`#${id}`)?.textContent).join(" ");
    expect(descriptions).toContain("saved-model");
    expect(descriptions).toMatch(/未验证连接|缺少 API Key/);
  }
});

it("connects navigation buttons to their original panels and field inputs to help text", () => {
  document.body.innerHTML = html;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(panel?.dataset.panel, button.dataset.section).toBe(button.dataset.section);
  }
  expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("设置导航");
  expect(document.getElementById("api-key")?.getAttribute("aria-describedby")).toBe("api-key-hint");
  expect(document.getElementById("base-url")?.getAttribute("aria-describedby")).toBe("endpoint-preview");
  expect(document.getElementById("save-status")?.getAttribute("aria-atomic")).toBe("true");
});

it("uses readable section typography and grouped rows without decorative backgrounds", () => {
  document.body.innerHTML = html;
  const style = document.createElement("style");
  style.textContent = withTypeScale(fs.readFileSync(path.resolve("src/renderer/settings/settings-layout.css"), "utf8"));
  document.head.append(style);
  try {
    expect(getComputedStyle(document.querySelector(".panel-heading h1")!).fontSize).toBe("26px");
    expect(getComputedStyle(document.querySelector(".setting-row")!).minHeight).toBe("72px");
    expect(getComputedStyle(document.querySelector(".settings-content")!).lineHeight).toBe("1.6");
    expect(document.querySelectorAll(".settings-nav__group")).toHaveLength(5);
  } finally { style.remove(); }
});


it("keeps a 48px title row and bounds independent settings scroll areas", () => {
  document.body.innerHTML = html;
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.resolve('src/renderer/settings/settings.css'), 'utf8') + '\n' + fs.readFileSync(path.resolve('src/renderer/settings/settings-layout.css'), 'utf8');
  document.head.append(style);
  try {
    expect(getComputedStyle(document.querySelector('.settings-titlebar')!).minHeight).toBe('48px');
    expect(getComputedStyle(document.querySelector('.settings-main')!).minHeight).toBe('0px');
    expect(getComputedStyle(document.querySelector('.settings-nav__list')!).overflowY).toBe('auto');
    expect(getComputedStyle(document.querySelector('.settings-content')!).overflowY).toBe('auto');
  } finally { style.remove(); }
});
