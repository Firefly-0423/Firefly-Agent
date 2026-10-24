// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_TIMEOUT_SETTINGS } from "../../shared/timeout-types";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";
import { CUSTOM_ENDPOINT_PROVIDERS } from "./custom-endpoint-state";
import type { FetchedModel, SettingsApi } from "./shared/types";
import type { SavedProfileLite } from "./api/state";

const html = fs.readFileSync(path.resolve("src/renderer/settings/index.html"), "utf8");
let profiles: SavedProfileLite[];
let general: Record<string, unknown>;
let saveProfile: ReturnType<typeof vi.fn>;
let deleteProfile: ReturnType<typeof vi.fn>;
let saveGeneral: ReturnType<typeof vi.fn>;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = html;
  element("save-status").textContent = "fixture initializing";
  profiles = [{ id: "existing", provider: "DeepSeek（深度求索）", displayName: "Existing", model: "old-manual-model", baseUrl: "https://example.invalid/v1", apiKey: "fixture-key", explicitTransport: "responses", multimodal: true }];
  general = { sidebarVisible: false, toastSoundEnabled: true, launchAtLogin: true, language: "zh-CN" };
  saveGeneral = vi.fn(async patch => { general = { ...general, ...patch }; return general; });
  saveProfile = vi.fn(async profile => {
    const id = profile.id || "new-profile";
    const added = !profile.id;
    profiles = [...profiles.filter(item => item.id !== id), { ...profile, id }];
    return { added, profiles, defaultModelProfileId: "existing" };
  });
  deleteProfile = vi.fn(async id => { profiles = profiles.filter(item => item.id !== id); return { profiles }; });
  window.settings = {
    getConfig: async () => ({ ...profiles[0], mode: "auto", stickerEnabled: false }),
    getGeneral: async () => general,
    saveGeneral,
    saveConfig: async config => config,
    listModelProfiles: async () => ({ profiles, defaultModelProfileId: "existing" }),
    saveModelProfile: saveProfile,
    deleteModelProfile: deleteProfile,
    getAgentRouting: async () => ({ profiles: [], routes: [], agents: SPECIALIST_AGENTS.map(agent => ({ ...agent })) }),
    getTimeoutSettings: async () => DEFAULT_TIMEOUT_SETTINGS,
    saveTimeoutSettings: async settings => settings,
    channelsGetConfig: async () => ({ wechat: {}, feishu: {}, qq: {} }),
    channelsGetStatus: async () => ({}),
    channelsLogGet: async () => [],
    channelsContextBindingsGet: async () => ({ externalChats: [], bindings: [], conversations: [] }),
    onChannelsStatusChanged: () => () => {},
    onChannelsWechatQrcode: () => () => {},
    onChannelsWechatLoginDone: () => () => {},
    onChannelsInstallProgress: () => () => {},
  } as unknown as SettingsApi;
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(1));
  await vi.waitFor(() => expect(element("save-status").textContent).toBe("等待保存"));
});

it("adds through the existing save bridge and reports save rejection while retaining entered data", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  expect(element("profile-editor").hidden).toBe(false);
  element<HTMLInputElement>("api-key").value = "entered-key";
  saveProfile.mockRejectedValueOnce(new Error("fixture write failure"));
  element<HTMLFormElement>("api-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  expect(element<HTMLInputElement>("api-key").value).toBe("entered-key");
  element<HTMLFormElement>("api-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  expect(profiles).toHaveLength(2);
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ apiKey: "entered-key", model: expect.any(String) });
});

it("shows the default profile name as a grey placeholder, and stores it when the field is left empty", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  const name = element<HTMLInputElement>("display-name");
  expect(name.value).toBe("");
  expect(name.placeholder).not.toBe("");
  const defaultName = name.placeholder;
  element<HTMLInputElement>("api-key").value = "entered-key";
  element<HTMLFormElement>("api-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ displayName: defaultName });
});

it("loads an existing model and protocol for editing without showing new-provider tabs", () => {
  const edit = document.querySelector<HTMLButtonElement>('[data-profile-action="edit"]')!;
  edit.focus();
  edit.click();
  expect(element<HTMLInputElement>("model-input").value).toBe("old-manual-model");
  expect(element<HTMLInputElement>("api-key").value).toBe("fixture-key");
  expect(document.querySelector('[data-value="responses"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector<HTMLElement>(".provider-tabs")?.hidden).toBe(true);
  expect(document.activeElement).toBe(element("api-key"));
});

it("does not reset the current add draft when the already selected tab is clicked", () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "draft-key";
  document.querySelector<HTMLButtonElement>('[data-provider-tab="preset"]')!.click();
  expect(element<HTMLInputElement>("api-key").value).toBe("draft-key");
});

it("opens the Custom API page with the keyboard and edits the original single-model profile", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  const preset = document.querySelector<HTMLButtonElement>('[data-provider-tab="preset"]')!;
  preset.focus();
  preset.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  const custom = document.querySelector<HTMLButtonElement>('[data-provider-tab="custom"]')!;
  expect(document.activeElement).toBe(custom);
  expect(custom.getAttribute("aria-selected")).toBe("true");
  expect(element("provider-preset-page").hidden).toBe(true);
  expect(element("custom-endpoint-controls").hidden).toBe(false);
  expect(element("model-input").closest("details")).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-profile-action="edit"]')!.click();
  element<HTMLInputElement>("model-input").value = "updated-manual-model";
  element<HTMLFormElement>("api-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ id: "existing", model: "updated-manual-model", explicitTransport: "responses", apiKey: "fixture-key" });
  expect(profiles).toHaveLength(1);
});

it("keeps rows on delete failure and removes only the selected profile on success", async () => {
  deleteProfile.mockRejectedValueOnce(new Error("fixture delete failure"));
  const remove = document.querySelector<HTMLButtonElement>('[data-profile-action="delete"]')!;
  remove.focus();
  remove.click();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  expect(profiles).toHaveLength(1);
  expect(document.activeElement).toBe(remove);
  document.querySelector<HTMLButtonElement>('[data-profile-action="delete"]')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(0));
  expect(deleteProfile).toHaveBeenLastCalledWith("existing");
  expect(document.activeElement).toBe(element("add-profile-btn"));
});

it("focuses a remaining row after deleting another configuration", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "new-key";
  element<HTMLFormElement>("api-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(2));
  const remove = document.querySelector<HTMLButtonElement>('[data-profile-id="existing"] [data-profile-action="delete"]')!;
  remove.focus();
  remove.click();
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(1));
  expect(document.activeElement).toBe(document.querySelector('[data-profile-id="new-profile"] [data-profile-action="edit"]'));
});

it("saves the language choice immediately without resetting the persisted hidden sidebar value", async () => {
  expect(element("sidebar-visible")).toBeNull();
  document.querySelector<HTMLButtonElement>('#language-select .language-option[data-lang="en"]')!.click();
  await vi.waitFor(() => expect(saveGeneral).toHaveBeenLastCalledWith({ language: "en" }));
  expect(saveGeneral.mock.calls.at(-1)?.[0]).not.toHaveProperty("sidebarVisible");
  expect(general.sidebarVisible).toBe(false);
});

it("places the desktop card after the language card with both switches and no About card", () => {
  const form = element("general-form");
  const toast = element<HTMLInputElement>("toast-sound-enabled");
  const launch = element<HTMLInputElement>("launch-at-login");
  const groupTitles = Array.from(form.querySelectorAll(".settings-group-title"), (node) => node.textContent);
  expect(groupTitles).toEqual(["本地文件", "桌面与系统"]);
  expect(toast.type).toBe("checkbox");
  expect(toast.closest("label")?.textContent).toContain("提醒音效");
  expect(launch.closest("label")?.textContent).toContain("开机自启");
  const language = element("language-select");
  expect(language.compareDocumentPosition(toast) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(form.querySelector(".setting-row--about")).toBeNull();
  expect(form.textContent).not.toContain("轻量情感陪伴");
});

it("puts the local file permission control in the general settings, not in the tools panel", () => {
  const form = element("general-form");
  expect(form.querySelector("#plugin-file-permission")).not.toBeNull();
  expect(form.querySelectorAll("#plugin-file-permission button[data-level]")).toHaveLength(4);
  expect(element("plugin-file-note")).toBeTruthy();
  expect(document.querySelector(".plugin-list #plugin-file-card")).toBeNull();
});

it("loads both desktop switches from the saved general settings", async () => {
  await vi.waitFor(() => expect(element<HTMLInputElement>("launch-at-login").checked).toBe(true));
  expect(element<HTMLInputElement>("toast-sound-enabled").checked).toBe(true);
});

it("saves each desktop switch immediately as its own patch", async () => {
  await vi.waitFor(() => expect(element<HTMLInputElement>("launch-at-login").checked).toBe(true));
  const toast = element<HTMLInputElement>("toast-sound-enabled");
  const launch = element<HTMLInputElement>("launch-at-login");
  toast.click();
  await vi.waitFor(() => expect(saveGeneral).toHaveBeenLastCalledWith({ toastSoundEnabled: false }));
  launch.click();
  await vi.waitFor(() => expect(saveGeneral).toHaveBeenLastCalledWith({ launchAtLogin: false }));
  expect(saveGeneral.mock.calls.at(-1)?.[0]).not.toHaveProperty("language");
  expect(general).toMatchObject({ toastSoundEnabled: false, launchAtLogin: false, language: "zh-CN" });
  expect(element("desktop-save-status").hidden).toBe(true);
});

it("rolls a rejected desktop switch back, reports the failure, and clears it on a later successful save", async () => {
  await vi.waitFor(() => expect(element<HTMLInputElement>("launch-at-login").checked).toBe(true));
  const launch = element<HTMLInputElement>("launch-at-login");
  const status = element("desktop-save-status");
  saveGeneral.mockRejectedValueOnce(new Error("fixture write failure"));
  launch.click();
  await vi.waitFor(() => expect(status.classList.contains("is-error")).toBe(true));
  expect(launch.checked).toBe(true);
  expect(status.hidden).toBe(false);
  expect(status.textContent).toBe("保存失败，请重试。");
  launch.click();
  await vi.waitFor(() => expect(status.hidden).toBe(true));
  expect(general.launchAtLogin).toBe(false);
});

const modalIsOpen = () => document.getElementById("ff-modal-overlay")?.classList.contains("is-hidden") === false;
const submitProfile = () => element<HTMLFormElement>("api-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const profileButton = () => document.querySelector<HTMLButtonElement>('[data-profile-id="existing"] [data-profile-action="edit"]')!;
// 卡片默认折叠：需要编辑器的用例先点“编辑”展开已存的档案。
const openExisting = () => profileButton().click();

it("starts with every card collapsed, keeps the default tag, and fills the global controls from the stored config", () => {
  expect(element("profile-editor").hidden).toBe(true);
  expect(element("profile-editor").parentElement).toBe(element("provider-editor-slot"));
  expect(document.querySelector('[data-profile-id="existing"] .provider-row__tag--default')?.textContent).toBe("默认");
  expect(profileButton().getAttribute("aria-expanded")).toBe("false");
  expect(profileButton().hasAttribute("aria-current")).toBe(false);
  expect(element<HTMLButtonElement>("add-profile-btn").hidden).toBe(false);
  expect(element("save-status").parentElement).toBe(element("provider-status-top"));
  expect(element<HTMLInputElement>("timeout-test").value).toBe(String(DEFAULT_TIMEOUT_SETTINGS.testTimeout));
});

it("opens a saved card inline on Edit, exposes it to assistive technology, and collapses it on a second click", () => {
  openExisting();
  expect(element("profile-editor").hidden).toBe(false);
  expect(profileButton().getAttribute("aria-current")).toBe("true");
  expect(profileButton().getAttribute("aria-expanded")).toBe("true");
  expect(element("profile-editor").parentElement).toBe(document.querySelector('[data-profile-id="existing"]'));
  expect(element<HTMLButtonElement>("add-profile-btn").hidden).toBe(false);
  expect(element("save-status").parentElement).toBe(element("provider-status-slot"));
  profileButton().click();
  expect(element("profile-editor").hidden).toBe(true);
  expect(element("profile-editor").parentElement).toBe(element("provider-editor-slot"));
  expect(profileButton().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(profileButton());
});

it("hides the cloud/local switch and guide inside a saved custom card but shows them when adding a custom API", async () => {
  profiles = [{ ...profiles[0], provider: CUSTOM_ENDPOINT_PROVIDERS.cloud, displayName: "Proxy" }];
  vi.resetModules();
  document.body.innerHTML = html;
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(1));
  openExisting();
  expect(element("custom-endpoint-controls").hidden).toBe(true);
  expect(element("provider-preset-page").hidden).toBe(true);
  element<HTMLButtonElement>("close-profile-editor").click();
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLButtonElement>("provider-custom-tab").click();
  expect(element("custom-endpoint-controls").hidden).toBe(false);
  expect(element("custom-endpoint-guide-btn")).not.toBeNull();
});

it("expands a new draft under the list in place of the add button, then moves into the new card once saved", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  expect(element("profile-editor").parentElement).toBe(element("provider-editor-slot"));
  expect(element<HTMLButtonElement>("add-profile-btn").hidden).toBe(true);
  expect(document.querySelector('[data-profile-id="existing"] #profile-editor')).toBeNull();
  element<HTMLInputElement>("api-key").value = "inline-new-key";
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  expect(element("profile-editor").parentElement).toBe(document.querySelector('[data-profile-id="new-profile"]'));
  expect(element<HTMLButtonElement>("add-profile-btn").hidden).toBe(false);
  expect(element<HTMLInputElement>("api-key").value).toBe("inline-new-key");
});

it("moves the editor between cards when another profile is chosen", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "second-key";
  submitProfile();
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(2));
  await vi.waitFor(() => expect(element("profile-draft-state").dataset.state).toBe("saved"));
  profileButton().click();
  expect(element("profile-editor").parentElement).toBe(document.querySelector('[data-profile-id="existing"]'));
  expect(element<HTMLInputElement>("api-key").value).toBe("fixture-key");
});

it("keeps a changed profile when discard is canceled and starts a clean draft only after confirmation", async () => {
  profileButton().click();
  element<HTMLInputElement>("api-key").value = "unsaved-existing-key";
  const add = element<HTMLButtonElement>("add-profile-btn");
  add.focus();
  add.click();
  expect(modalIsOpen()).toBe(true);
  expect(element<HTMLInputElement>("api-key").value).toBe("unsaved-existing-key");
  expect(document.activeElement).toBe(element("ff-modal-cancel"));
  element<HTMLButtonElement>("ff-modal-cancel").click();
  await vi.waitFor(() => expect(modalIsOpen()).toBe(false));
  expect(element<HTMLInputElement>("api-key").value).toBe("unsaved-existing-key");
  expect(document.activeElement).toBe(add);
  add.click();
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(element<HTMLInputElement>("api-key").value).toBe(""));
  expect(element("delete-profile-btn").hidden).toBe(true);
  expect(document.activeElement).toBe(element("api-key"));
});

it("retains an unsaved new profile on repeat Add or provider selection and guards a different provider", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "new-draft-key";
  element<HTMLButtonElement>("add-profile-btn").click();
  document.querySelector<HTMLButtonElement>('#preset-cards .is-active')!.click();
  expect(element<HTMLInputElement>("api-key").value).toBe("new-draft-key");
  expect(modalIsOpen()).toBe(false);
  document.querySelector<HTMLButtonElement>('#preset-cards .preset-card:not(.is-active):not(:disabled)')!.click();
  expect(modalIsOpen()).toBe(true);
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(element<HTMLInputElement>("api-key").value).toBe(""));
});

it("asks before a repeat click collapses an open card with changes, and keeps the changed model when canceled", async () => {
  profileButton().click();
  element<HTMLInputElement>("model-input").value = "unsaved-model";
  profileButton().click();
  expect(modalIsOpen()).toBe(true);
  element<HTMLButtonElement>("ff-modal-cancel").click();
  await vi.waitFor(() => expect(modalIsOpen()).toBe(false));
  expect(element("profile-editor").hidden).toBe(false);
  expect(element<HTMLInputElement>("model-input").value).toBe("unsaved-model");
  profileButton().click();
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(element("profile-editor").hidden).toBe(true));
});

it("cancels a keyboard provider tab switch without moving selection or focus, then confirms it", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "tab-draft-key";
  const preset = element<HTMLButtonElement>("provider-preset-tab");
  const custom = element<HTMLButtonElement>("provider-custom-tab");
  preset.focus();
  preset.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  expect(modalIsOpen()).toBe(true);
  expect(preset.getAttribute("aria-selected")).toBe("true");
  element<HTMLButtonElement>("ff-modal-cancel").click();
  await vi.waitFor(() => expect(modalIsOpen()).toBe(false));
  expect(document.activeElement).toBe(preset);
  expect(element<HTMLInputElement>("api-key").value).toBe("tab-draft-key");
  preset.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(custom.getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement).toBe(custom);
});

it("guards custom endpoint mode changes and keeps the editor usable on confirmed switches", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLButtonElement>("provider-custom-tab").click();
  element<HTMLInputElement>("model-input").value = "custom-draft";
  document.querySelector<HTMLButtonElement>('[data-custom-endpoint-mode="local"]')!.click();
  expect(modalIsOpen()).toBe(true);
  expect(document.querySelector('[data-custom-endpoint-mode="cloud"]')?.getAttribute("aria-pressed")).toBe("true");
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(document.querySelector('[data-custom-endpoint-mode="local"]')?.getAttribute("aria-pressed")).toBe("true"));
});

it("keeps a failed save dirty and clears the discard guard only after a successful save", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "save-draft-key";
  saveProfile.mockRejectedValueOnce(new Error("write failed"));
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  profileButton().click();
  expect(modalIsOpen()).toBe(true);
  element<HTMLButtonElement>("ff-modal-cancel").click();
  await vi.waitFor(() => expect(modalIsOpen()).toBe(false));
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  profileButton().click();
  expect(modalIsOpen()).toBe(false);
  expect(element<HTMLInputElement>("api-key").value).toBe("fixture-key");
});

it("keeps edits made during an in-flight save dirty and prevents selection races", async () => {
  profileButton().click();
  element<HTMLInputElement>("api-key").value = "submitted-key";
  let finishSave!: (result: unknown) => void;
  saveProfile.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  expect(element("save-status").classList.contains("is-ok")).toBe(false);
  element<HTMLInputElement>("api-key").value = "newer-unsaved-key";
  element<HTMLButtonElement>("add-profile-btn").click();
  expect(element<HTMLInputElement>("api-key").value).toBe("newer-unsaved-key");
  finishSave({ added: false, profiles, defaultModelProfileId: "existing" });
  await vi.waitFor(() => expect(element("save-status").textContent).toBe("提交的版本已保存，仍有未保存的更改"));
  expect(element("save-status").classList.contains("is-ok")).toBe(false);
  element<HTMLButtonElement>("add-profile-btn").click();
  expect(modalIsOpen()).toBe(true);
  element<HTMLButtonElement>("ff-modal-cancel").click();
});

it("preserves the draft across settings categories and asks before closing its editor", async () => {
  profileButton().click();
  element<HTMLInputElement>("api-key").value = "category-draft-key";
  document.querySelector<HTMLButtonElement>('.nav-item[data-section="general"]')!.click();
  document.querySelector<HTMLButtonElement>('.nav-item[data-section="api"]')!.click();
  expect(element<HTMLInputElement>("api-key").value).toBe("category-draft-key");
  expect(modalIsOpen()).toBe(false);
  element<HTMLButtonElement>("close-profile-editor").click();
  expect(modalIsOpen()).toBe(true);
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(element("profile-editor").hidden).toBe(true));
  expect(element("profile-editor").parentElement).toBe(element("provider-editor-slot"));
  expect(element("save-status").parentElement).toBe(element("provider-status-top"));
  expect(document.activeElement).toBe(profileButton());
});

it("keeps the newly saved profile identity if the global-options save fails, so retry updates it", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "partial-save-key";
  const saveConfig = vi.fn().mockRejectedValueOnce(new Error("global save failed")).mockResolvedValue({});
  window.settings!.saveConfig = saveConfig;
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  expect(element<HTMLInputElement>("api-key").value).toBe("partial-save-key");
  expect(element("delete-profile-btn").hidden).toBe(false);
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ id: "new-profile", apiKey: "partial-save-key" });
  expect(profiles).toHaveLength(2);
});

it("uses one discard prompt for repeated switch attempts and keeps the original target", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "switch-draft-key";
  profileButton().click();
  element<HTMLButtonElement>("provider-custom-tab").click();
  expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
  element<HTMLButtonElement>("ff-modal-confirm").click();
  await vi.waitFor(() => expect(element<HTMLInputElement>("api-key").value).toBe("fixture-key"));
  expect(modalIsOpen()).toBe(false);
});

it("keeps duplicate and invalid save drafts guarded and does not save their changes", async () => {
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLInputElement>("api-key").value = "duplicate-draft-key";
  saveProfile.mockResolvedValueOnce({ added: false, profiles, defaultModelProfileId: "existing" });
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  profileButton().click();
  expect(modalIsOpen()).toBe(true);
  element<HTMLButtonElement>("ff-modal-cancel").click();
  await vi.waitFor(() => expect(modalIsOpen()).toBe(false));
  element<HTMLInputElement>("timeout-test").value = "-1";
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  profileButton().click();
  expect(modalIsOpen()).toBe(true);
  expect(saveProfile).toHaveBeenCalledTimes(1);
  element<HTMLButtonElement>("ff-modal-cancel").click();
});


it("distinguishes saved profiles, changed drafts, and a clean new draft without claiming connection success", async () => {
  const state = () => element("profile-draft-state");
  openExisting();
  expect(state()?.textContent).toBe("已保存的档案");
  const key = element<HTMLInputElement>("api-key");
  key.value = "changed-key";
  key.dispatchEvent(new Event("input", { bubbles: true }));
  expect(state().textContent).toBe("未保存的更改");
  expect(state().dataset.state).toBe("dirty");
  document.querySelector<HTMLButtonElement>('.nav-item[data-section="general"]')!.click();
  document.querySelector<HTMLButtonElement>('.nav-item[data-section="api"]')!.click();
  expect(state().textContent).toBe("未保存的更改");
  element<HTMLButtonElement>("add-profile-btn").click();
  element<HTMLButtonElement>("ff-modal-cancel").click();
  await vi.waitFor(() => expect(modalIsOpen()).toBe(false));
  expect(state().textContent).toBe("未保存的更改");
  saveProfile.mockRejectedValueOnce(new Error("fixture write failure"));
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-error")).toBe(true));
  expect(state().textContent).toBe("未保存的更改");
  submitProfile();
  await vi.waitFor(() => expect(state().textContent).toBe("已保存的档案"));
  expect(state().textContent).not.toContain("连接");
  element<HTMLButtonElement>("add-profile-btn").click();
  expect(state().textContent).toBe("新建草稿 · 尚未保存");
});

it("keeps pending save feedback accurate while a newer change is made and submitted later", async () => {
  openExisting();
  const key = element<HTMLInputElement>("api-key");
  key.value = "submitted-key";
  key.dispatchEvent(new Event("input", { bubbles: true }));
  let finishSave!: (result: unknown) => void;
  saveProfile.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  expect(element("profile-editor").getAttribute("aria-busy")).toBe("true");
  expect(element("profile-draft-state").textContent).toBe("保存中…");
  key.value = "newer-key";
  key.dispatchEvent(new Event("input", { bubbles: true }));
  finishSave({ added: false, profiles, defaultModelProfileId: "existing" });
  await vi.waitFor(() => expect(element("profile-editor").getAttribute("aria-busy")).toBe("false"));
  expect(element("profile-draft-state").textContent).toBe("未保存的更改");
  expect(element("save-status").textContent).toBe("提交的版本已保存，仍有未保存的更改");
  expect(key.value).toBe("newer-key");
  submitProfile();
  await vi.waitFor(() => expect(element("profile-draft-state").textContent).toBe("已保存的档案"));
  expect(profiles[0].apiKey).toBe("newer-key");
});


it("refreshes a clean saved editor from Main without replacing its key from the catalog", async () => {
  openExisting();
  const key = element<HTMLInputElement>("api-key");
  key.value = "submitted-key";
  saveProfile.mockImplementationOnce(async profile => {
    profiles = [{ ...profile, id: "existing", displayName: "Canonical name", model: "canonical-model", apiKey: "not-for-input" }];
    return { added: false, profiles, defaultModelProfileId: "existing" };
  });
  submitProfile();
  await vi.waitFor(() => expect(element("save-status").classList.contains("is-ok")).toBe(true));
  expect(element<HTMLInputElement>("display-name").value).toBe("Canonical name");
  expect(element<HTMLInputElement>("model-input").value).toBe("canonical-model");
  expect(key.value).toBe("submitted-key");
  expect(element("profile-draft-state").dataset.state).toBe("saved");
});

it("returns editor collapse focus to the saved profile that opened it", () => {
  profileButton().focus();
  profileButton().click();
  element<HTMLButtonElement>("close-profile-editor").click();
  expect(element("profile-editor").hidden).toBe(true);
  expect(document.activeElement).toBe(profileButton());
});

it("disables only save and switching actions during a write while retaining editable draft fields", async () => {
  openExisting();
  let finish!: (result: unknown) => void;
  saveProfile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  expect(document.querySelector<HTMLButtonElement>('#api-form button[type="submit"]')!.disabled).toBe(true);
  expect(element<HTMLButtonElement>("close-profile-editor").disabled).toBe(true);
  expect(element<HTMLInputElement>("model-input").disabled).toBe(false);
  submitProfile();
  expect(saveProfile).toHaveBeenCalledTimes(1);
  finish({ added: false, profiles, defaultModelProfileId: "existing" });
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#api-form button[type="submit"]')!.disabled).toBe(false));
  expect(element<HTMLButtonElement>("close-profile-editor").disabled).toBe(false);
});

it("ignores an old save response after the settings panel is remounted", async () => {
  openExisting();
  let finish!: (result: unknown) => void;
  saveProfile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  vi.resetModules();
  document.body.innerHTML = html;
  const newSaveConfig = vi.fn(async config => config);
  window.settings!.saveConfig = newSaveConfig;
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(1));
  openExisting();
  await vi.waitFor(() => expect(element("profile-draft-state").dataset.state).toBe("saved"));
  const key = element<HTMLInputElement>("api-key");
  key.value = "fresh-panel-draft";
  key.dispatchEvent(new Event("input", { bubbles: true }));
  expect(element("profile-draft-state").dataset.state).toBe("dirty");
  finish({ added: false, profiles, defaultModelProfileId: "existing" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(newSaveConfig).not.toHaveBeenCalled();
  expect(element("profile-draft-state").dataset.state).toBe("dirty");
  expect(key.value).toBe("fresh-panel-draft");
});

const pressedInputType = () => document.querySelector('#input-modalities-select [aria-pressed="true"]')?.getAttribute("data-value");

it("saves a hand-set input type as a user declaration and returns to automatic by clearing it", async () => {
  openExisting();
  expect(pressedInputType()).toBe("auto");
  element<HTMLElement>("input-modalities-select").querySelector<HTMLButtonElement>('[data-value="image"]')!.click();
  expect(pressedInputType()).toBe("image");
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ id: "existing", inputModalities: ["text", "image"], inputModalitiesSource: "user" });
  await vi.waitFor(() => expect(element("profile-draft-state").dataset.state).toBe("saved"));
  expect(pressedInputType()).toBe("image");

  element<HTMLElement>("input-modalities-select").querySelector<HTMLButtonElement>('[data-value="auto"]')!.click();
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2));
  expect(saveProfile.mock.calls.at(-1)?.[0].inputModalities).toBeUndefined();
  expect(saveProfile.mock.calls.at(-1)?.[0].inputModalitiesSource).toBeUndefined();
});

it("records a vendor-declared input type when a fetched model is picked, and drops it once the model id is edited by hand", async () => {
  window.settings!.fetchModels = vi.fn(async (): Promise<{ ok: true; models: FetchedModel[] }> => ({
    ok: true,
    models: [{ id: "vendor-vision-x", inputModalities: ["text", "image"] }, { id: "vendor-text-y", inputModalities: ["text"] }],
  }));
  openExisting();
  element<HTMLButtonElement>("fetch-models-btn").click();
  await vi.waitFor(() => expect(document.querySelectorAll("#fetch-models-list [data-model-id]")).toHaveLength(2));
  document.querySelector<HTMLButtonElement>('[data-model-id="vendor-vision-x"]')!.click();
  expect(element<HTMLInputElement>("model-input").value).toBe("vendor-vision-x");
  expect(pressedInputType()).toBe("auto");
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ model: "vendor-vision-x", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" });
  await vi.waitFor(() => expect(element("profile-draft-state").dataset.state).toBe("saved"));

  const model = element<HTMLInputElement>("model-input");
  model.value = "hand-typed-z";
  model.dispatchEvent(new Event("input", { bubbles: true }));
  expect(pressedInputType()).toBe("auto");
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ model: "hand-typed-z" });
  expect(saveProfile.mock.calls.at(-1)?.[0].inputModalities).toBeUndefined();
});

it("also records the vendor-declared input type when a fetched model id is chosen through the native datalist", async () => {
  window.settings!.fetchModels = vi.fn(async (): Promise<{ ok: true; models: FetchedModel[] }> => ({
    ok: true,
    models: [{ id: "vendor-vision-x", inputModalities: ["text", "image"] }, { id: "vendor-text-y", inputModalities: ["text"] }],
  }));
  openExisting();
  element<HTMLButtonElement>("fetch-models-btn").click();
  await vi.waitFor(() => expect(document.querySelectorAll("#fetch-models-list [data-model-id]")).toHaveLength(2));
  // 不点自定义选择器：直接把输入框设成列表里的 id，等同于在原生 datalist 里选中
  const model = element<HTMLInputElement>("model-input");
  model.value = "vendor-vision-x";
  model.dispatchEvent(new Event("input", { bubbles: true }));
  submitProfile();
  await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
  expect(saveProfile.mock.calls.at(-1)?.[0]).toMatchObject({ model: "vendor-vision-x", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" });
});
