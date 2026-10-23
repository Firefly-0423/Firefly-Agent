import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeGeneralSettings as normalize } from "./settings-facade";
import { DEFAULT_UI_COLORS } from "../../shared/ui-colors";
const profile = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.root } }));
beforeEach(() => { profile.root = mkdtempSync(join(tmpdir(), "ff-settings-contract-")); vi.resetModules(); });
afterEach(() => rmSync(profile.root, { recursive: true, force: true }));
const retired = { momentsEnabled: true, chatMomentsContextEnabled: true, fireflyMomentsPostingEnabled: true,
  fireflyMomentsReactionsEnabled: true, momentsCharacterReactionsEnabled: true, momentsLiveliness: "quiet" };
const fresh = async () => { vi.resetModules(); return import("./settings-facade"); };
it("drops retired Moments controls while retaining shared and historic skill preferences", () => {
  const shared = { chatSocialContextEnabled: true, asrEngine: "mossland" as const,
    toolModeOverrides: { garden_search: { work: true } }, skillModeOverrides: { assessment: { work: false },
      tutoring: { work: true }, "knowledge-workspace": { work: true } } };
  expect(normalize({ ...shared, ...retired } as never)).toMatchObject(shared);
  for (const key of Object.keys(retired)) {
    expect(normalize({ ...retired } as never)).not.toHaveProperty(key);
    expect(normalize({})).not.toHaveProperty(key);
  }
});
it("discards removed modes without losing explicit work overrides", () => {
  const result = normalize({ toolModeOverrides: { garden_edit: { learn: true, work: false }, garden_read: { learn: true } },
    skillModeOverrides: { horticulture: { learn: true }, planting: { learn: true, work: false } } } as never);
  expect(result.toolModeOverrides).toEqual({ garden_edit: { work: false } });
  expect(result.skillModeOverrides).toEqual({ planting: { work: false } });
});
it("validates LSP ids, removes duplicate or blank overrides and strips unsafe object keys", () => {
  const result = normalize({ lspServerOverrides: [
    { id: "python-pyright", command: "garden-pyright", args: ["--stdio"] },
    { id: "python-pyright", command: "duplicate-ignored" }, { id: "unregistered-lsp", command: "ignored" },
    { id: "gopls", command: " \t" },
    { id: "typescript-language-server", initializationOptions: { preferences: { includePackageJsonAutoImports: "on" } }, constructor: "unsafe-constructor" },
  ] } as never);
  expect(result.lspServerOverrides).toEqual([
    { id: "python-pyright", command: "garden-pyright", args: ["--stdio"] },
    { id: "typescript-language-server", initializationOptions: { preferences: { includePackageJsonAutoImports: "on" } } },
  ]);
  expect(normalize({}).lspServerOverrides).toEqual([]);
});
it("uses finite run defaults, explicit zero for unlimited, truncation and bounded limits", () => {
  expect(normalize({})).toMatchObject({ maxToolRounds: 200, runTimeoutMinutes: 120 });
  expect(normalize({ maxToolRounds: 0, runTimeoutMinutes: 0 })).toMatchObject({ maxToolRounds: 0, runTimeoutMinutes: 0 });
  expect(normalize({ maxToolRounds: 80000, runTimeoutMinutes: 80000 })).toMatchObject({ maxToolRounds: 10000, runTimeoutMinutes: 1440 });
  expect(normalize({ maxToolRounds: 19.8 }).maxToolRounds).toBe(19);
  for (const value of [null, "", "  ", -7, "invalid-number"]) {
    expect(normalize({ maxToolRounds: value, runTimeoutMinutes: value } as never)).toMatchObject({ maxToolRounds: 200, runTimeoutMinutes: 120 });
  }
  expect(normalize({ maxToolRounds: "0", runTimeoutMinutes: "45" } as never)).toMatchObject({ maxToolRounds: 0, runTimeoutMinutes: 45 });
});
it("normalizes parallel tool allowances to the one-through-eight range", () => {
  expect(normalize({}).maxParallelToolCalls).toBe(4);
  expect([0, 92, 3.6, "not-numeric"].map(value => normalize({ maxParallelToolCalls: value } as never).maxParallelToolCalls)).toEqual([1, 8, 3, 4]);
});
it.each(["local", "mossland", "aliyun", "off"] as const)("retains %s ASR credentials while dropping retired Call settings", asrEngine => {
  const shared = { asrEngine, asrAliyunAppKey: "garden-app", asrAliyunAccessKeyId: "garden-id",
    asrAliyunAccessKeySecret: "garden-secret", asrLanguage: "en" as const, asrMosslandKey: "garden-channel-key" };
  const result = normalize({ ...shared, asrVadSilenceMs: 1800, asrVadThreshold: 0.3, asrShowTranscript: true } as never);
  expect(result).toMatchObject(shared);
  for (const key of ["asrVadSilenceMs", "asrVadThreshold", "asrShowTranscript"]) {
    expect(result).not.toHaveProperty(key);
    expect(normalize({})).not.toHaveProperty(key);
  }
});
it("restores interface language and the independent music switch defaults", () => {
  expect([{}, { language: "en" }, { language: "ja" }, { language: "ko" }].map(value => normalize(value as never).language))
    .toEqual(["zh-CN", "en", "zh-CN", "zh-CN"]);
  expect([{}, { weatherEnabled: true }, { musicEnabled: false }, { musicEnabled: true }].map(normalize).map(value => value.musicEnabled))
    .toEqual([true, true, false, true]);
});
it("ignores TTS controls while retaining the channel ASR key and ordinary audio preferences", () => {
  const result = normalize({ ttsEngine: "mossland", ttsAutoRead: true, ttsMosslandKey: "garden-channel-legacy",
    asrEngine: "mossland", toastSoundEnabled: true } as never);
  for (const key of ["ttsEngine", "ttsAutoRead", "ttsMosslandKey"]) expect(result).not.toHaveProperty(key);
  expect(result).toMatchObject({ asrEngine: "mossland", asrMosslandKey: "garden-channel-legacy", toastSoundEnabled: true });
});
it("normalizes light and dark custom colors independently and rejects invalid CSS values", () => {
  const colors = { enabled: true, accent: "#345678", background: "#fafafa", foreground: "#242424" };
  expect(normalize({ uiColors: colors }).uiColors).toEqual({ ...colors, dark: DEFAULT_UI_COLORS.dark });
  expect(normalize({ uiColors: { ...colors, dark: { accent: "#6ACDAF", background: "invalid-color" } } }).uiColors.dark)
    .toEqual({ accent: "#6acdaf", background: DEFAULT_UI_COLORS.dark.background, foreground: DEFAULT_UI_COLORS.dark.foreground });
  expect(normalize({ uiColors: { ...colors, accent: "url(private)" } }).uiColors.accent).toBe("#0285ff");
});
it("uses current typography defaults and clamps older appearance archives without retaining removed radius controls", () => {
  expect(normalize({})).toMatchObject({ chatLineHeight: 1.75, chatParaSpacing: 0.5, uiFontSize: 16, chatFontSize: 14, codeFontSize: 13 });
  const legacy = normalize({ chatLineHeight: 1.6, windowCornerRadius: 28, uiThemeRadius: true } as never);
  expect(legacy).toMatchObject({ chatLineHeight: 1.6, chatFontSize: 14, codeFontSize: 13, uiFontSize: 16 });
  expect(legacy).not.toHaveProperty("windowCornerRadius");
  expect(legacy).not.toHaveProperty("uiThemeRadius");
  expect(normalize({ uiFontSize: 4, chatFontSize: 71, codeFontSize: 3, chatParaSpacing: 8 }))
    .toMatchObject({ uiFontSize: 12, chatFontSize: 22, codeFontSize: 11, chatParaSpacing: 1.2 });
});
it("persists typography and custom colors across actual settings module reloads", async () => {
  const colors = { enabled: true, accent: "#345678", background: "#242424", foreground: "#fafafa" };
  (await fresh()).saveGeneralSettings({ uiColors: colors, uiFontSize: 19, chatFontSize: 88, codeFontSize: 12, chatParaSpacing: 0.8, chatLineHeight: 1.9 });
  const reopened = await fresh();
  expect(reopened.loadGeneralSettings()).toMatchObject({ uiFontSize: 19, chatFontSize: 22, codeFontSize: 12, chatParaSpacing: 0.8, chatLineHeight: 1.9 });
  expect(reopened.loadGeneralSettings().uiColors).toEqual({ ...colors, dark: DEFAULT_UI_COLORS.dark });
  reopened.saveGeneralSettings({ uiColors: { ...colors, enabled: false } });
  expect((await fresh()).loadGeneralSettings().uiColors.enabled).toBe(false);
});
it("applies the installer login choice while preserving retired keys on disk", async () => {
  const saved = { ...retired, chatSocialContextEnabled: true, launchAtLogin: false }, target = join(profile.root, "app-settings.json");
  writeFileSync(target, JSON.stringify(saved));
  writeFileSync(join(profile.root, "installer-options.json"), JSON.stringify({ launchAtLogin: true }));
  const facade = await fresh(), loaded = facade.loadGeneralSettings();
  expect(loaded).toMatchObject({ chatSocialContextEnabled: true, launchAtLogin: true });
  for (const key of Object.keys(retired)) expect(loaded).not.toHaveProperty(key);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ ...saved, launchAtLogin: true });
});
it("reads historical settings without rewriting retired preferences or old Moments data", async () => {
  const target = join(profile.root, "app-settings.json"), oldData = join(profile.root, "moments.json");
  const bytes = JSON.stringify({ ...retired, chatSocialContextEnabled: true, asrEngine: "mossland", disableGpuElectron: true });
  writeFileSync(target, bytes); writeFileSync(oldData, "GARDEN_OLD_DATA_CANARY");
  const loaded = (await fresh()).loadGeneralSettings();
  expect(loaded).toMatchObject({ chatSocialContextEnabled: true, asrEngine: "mossland" });
  for (const key of [...Object.keys(retired), "disableGpuElectron"]) expect(loaded).not.toHaveProperty(key);
  expect(readFileSync(target, "utf8")).toBe(bytes);
  expect(readFileSync(oldData, "utf8")).toBe("GARDEN_OLD_DATA_CANARY");
});
it("persists per-tool overrides through merges, reloads and disabling the global Chat tool switch", async () => {
  (await fresh()).saveGeneralSettings({ chatToolsEnabled: true, toolModeOverrides: { garden_search: { chat: true }, rain_check: { chat: true } } });
  const second = await fresh(), loaded = second.loadGeneralSettings();
  expect(loaded.chatToolsEnabled).toBe(true);
  expect(loaded.toolModeOverrides).toEqual({ garden_search: { chat: true }, rain_check: { chat: true } });
  second.saveGeneralSettings({ toolModeOverrides: { ...loaded.toolModeOverrides, garden_shell: { code: false } } });
  const third = await fresh();
  const expected = { garden_search: { chat: true }, rain_check: { chat: true }, garden_shell: { code: false } };
  expect(third.loadGeneralSettings().toolModeOverrides).toEqual(expected);
  expect(third.loadGeneralSettings().chatToolsEnabled).toBe(true);
  third.saveGeneralSettings({ chatToolsEnabled: false });
  const disabled = (await fresh()).loadGeneralSettings();
  expect(disabled.chatToolsEnabled).toBe(false);
  expect(disabled.toolModeOverrides).toEqual(expected);
});
