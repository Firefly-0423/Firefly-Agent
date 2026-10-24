import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "./model-settings";

const io = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), write: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs", () => ({ default: { statSync: io.stat, readFileSync: io.read, writeFileSync: io.write, mkdirSync: io.mkdir, renameSync: io.rename, unlinkSync: io.unlink } }));
// 凭据存储在写盘前会询问系统加密是否可用；这里固定为不可用，走明文回退路径。
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock("../settings-store", () => ({ getSettingsPath: () => "E:/synthetic/model-settings.json" }));
vi.mock("../logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() }, LogTag: { Runtime: "runtime" } }));

let m: typeof import("./model-settings");
const profile = { id: "p1", provider: "Custom", baseUrl: "https://model.example/v1", model: "fixture", apiKey: "fake-key", explicitTransport: "openai" as const };
const source = { kind: "production" as const, applicationName: "Firefly", appData: "E:/synthetic", userData: "E:/synthetic/Firefly", sessionData: "E:/synthetic/Firefly", logs: "E:/synthetic/logs" };
function disk(input: unknown) { io.stat.mockReturnValue({ size: 100 }); io.read.mockReturnValue(JSON.stringify(input)); }
function saved() { return JSON.parse(String(io.write.mock.calls.at(-1)?.[1])) as ModelSettings; }
beforeEach(async () => {
  vi.resetModules(); Object.values(io).forEach(mock => mock.mockReset());
  io.stat.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  io.read.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  m = await import("./model-settings");
});

describe("model settings normalization", () => {
  it.each([undefined, null, {}])("supplies product defaults for %j", input => {
    expect(m.normalizeModelSettings(input)).toMatchObject({ mode: "auto", schemaVersion: 2, provider: "MiniMax（稀宇科技）",
      baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3", apiKey: "", explicitTransport: "anthropic",
      stickerEnabled: false, stickerSize: "standard", stickerSimilarityThreshold: 0.55, chatRequestTimeoutSec: 300,
      rerankerMode: "standard", embeddingModel: "bgem3", modelProfiles: [], contextWindowTokens: 1_000_000, contextWindowVersion: 2 });
  });
  it("trims the provider/profile and gives per-provider values priority over top-level mirrors", () => {
    const input = { provider: " Custom ", baseUrl: "ignored", model: "ignored", apiKey: "ignored", mode: "manual" as const,
      perProvider: { " ": profile, " Custom ": { ...profile, baseUrl: " https://new.example ", model: " new ", apiKey: " key ", displayName: " Nick " } } };
    const result = m.normalizeModelSettings(input);
    expect(result).toMatchObject({ provider: "Custom", mode: "manual", baseUrl: "https://new.example", model: "new", apiKey: "key", displayName: "Nick" });
    expect(Object.keys(result.perProvider)).toEqual(["Custom"]);
    expect(input.perProvider[" Custom "].model).toBe(" new ");
  });
  it("sanitizes malformed optional fields and invalid saved profiles", () => {
    const result = m.normalizeModelSettings({ provider: " ", mode: "bad", stickerEnabled: "true", stickerSize: "huge",
      rerankerMode: "other", embeddingModel: "other", perProvider: "bad", modelProfiles: [null, {}, { id: 1, provider: "Custom" }, profile] } as unknown as Partial<ModelSettings>);
    expect(result).toMatchObject({ provider: "MiniMax（稀宇科技）", mode: "auto", stickerEnabled: false, stickerSize: "standard", rerankerMode: "standard", embeddingModel: "bgem3", defaultModelProfileId: "p1" });
    expect(result.modelProfiles).toHaveLength(1);
  });
  it.each([[0, 30], [30, 30], [30.6, 31], [1801, 1800], [NaN, 300], [Infinity, 300], ["90", 300]])(
    "normalizes chat timeout %s to %s", (raw, expected) => expect(m.normalizeModelSettings({ chatRequestTimeoutSec: raw } as Partial<ModelSettings>).chatRequestTimeoutSec).toBe(expected),
  );
  it.each([[0, 0.3], [0.3, 0.3], [0.7, 0.7], [1, 0.9], ["0.6", 0.55]])(
    "clamps sticker threshold %s to %s", (raw, expected) => expect(m.normalizeModelSettings({ stickerSimilarityThreshold: raw } as Partial<ModelSettings>).stickerSimilarityThreshold).toBe(expected),
  );
  it.each([[0, undefined], [-1, undefined], [Infinity, undefined], ["128", undefined], [128.6, 129]])(
    "normalizes embedding dimensions %s", (raw, expected) => expect(m.normalizeModelSettings({ embeddingDimensions: raw } as Partial<ModelSettings>).embeddingDimensions).toBe(expected),
  );
  it.each(["small", "large"] as const)("keeps sticker size %s and explicit global options", stickerSize => {
    expect(m.normalizeModelSettings({ stickerSize, stickerEnabled: true, rerankerMode: "none", thinkingOverride: -1, disableMaxToken: true }))
      .toMatchObject({ stickerSize, stickerEnabled: true, rerankerMode: "none", thinkingOverride: -1, disableMaxToken: true });
  });
  it("resolves explicit/default/fallback profiles and returns settings for a missing ID", () => {
    const settings = m.normalizeModelSettings({ modelProfiles: [profile, { ...profile, id: "p2", model: "other", contextWindowTokens: 8192 }], defaultModelProfileId: "p2" });
    expect(m.listSavedModelProfiles(settings).map(p => p.id)).toEqual(["p1", "p2"]);
    expect(m.getDefaultModelProfile(settings)?.id).toBe("p2");
    expect(m.resolveModelSettingsProfile(settings)).toMatchObject({ model: "other", contextWindowTokens: 8192 });
    expect(m.resolveModelSettingsProfile(settings, "p1")).toMatchObject({ model: "fixture", contextWindowTokens: 1_000_000 });
    expect(m.resolveModelSettingsProfile(settings, "missing")).toBe(settings);
    settings.defaultModelProfileId = "deleted";
    expect(m.getDefaultModelProfile(settings)?.id).toBe("p1");
    const empty = m.normalizeModelSettings({});
    expect(m.getDefaultModelProfile(empty)).toBeUndefined();
    expect(m.resolveModelSettingsProfile(empty)).toBe(empty);
  });
});

describe("settings persistence and model profiles", () => {
  it("loads missing settings once, uses cache, and does not write defaults", () => {
    const settings = m.loadModelSettings();
    expect(m.loadModelSettings()).toBe(settings);
    expect(settings.model).toBe("MiniMax-M3");
    expect(io.stat).toHaveBeenCalledTimes(1); expect(io.read).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
    expect(m.listSavedModelProfiles()).toEqual([]);
    expect(() => m.assertModelSettingsReadable()).not.toThrow();
  });
  it.each(["{", "null", "[]", '{"schemaVersion":1,"modelProfiles":[]}', '{"schemaVersion":2}',
    '{"schemaVersion":2,"modelProfiles":[{}]}', '{"schemaVersion":2,"modelProfiles":[],"perProvider":[]}',
    '{"schemaVersion":2,"modelProfiles":[],"perProvider":{"x":null}}'])("preserves unreadable data and refuses writes: %s", raw => {
    io.stat.mockReturnValue({ size: 100 }); io.read.mockReturnValue(raw);
    expect(m.loadModelSettings().model).toBe("MiniMax-M3");
    const message = "MODEL_SETTINGS_READ_FAILED: 模型配置读取失败，原文件已保留";
    expect(() => m.assertModelSettingsReadable()).toThrow(new Error(message));
    expect(() => m.saveModelSettings({ model: "changed" })).toThrow(new Error(message));
    expect(() => m.saveModelProfile(profile)).toThrow(new Error(message));
    expect(m.getCachedSavedModelProfile("p1")).toBeUndefined();
    expect(m.listCachedSavedModelProfileIds()).toEqual([]);
    expect(io.write).not.toHaveBeenCalled();
  });
  it("refuses writes after non-ENOENT stat failures", () => {
    io.stat.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(() => m.assertModelSettingsReadable()).toThrow(/^MODEL_SETTINGS_READ_FAILED: 模型配置读取失败，原文件已保留$/);
    expect(io.read).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  });
  it("merges provider profiles, writes consistent mirrors, and updates the loaded cache", () => {
    disk({ schemaVersion: 2, modelProfiles: [], provider: "Custom", perProvider: { Custom: profile } });
    const cached = m.loadModelSettings();
    const result = m.saveModelSettings({ model: " updated ", perProvider: { Other: { ...profile, model: "other" } } });
    expect(result).toMatchObject({ provider: "Custom", model: "updated", apiKey: "fake-key" });
    expect(result.perProvider.Other.model).toBe("other");
    expect(saved()).toEqual(JSON.parse(JSON.stringify(result)));
    expect(cached.model).toBe("updated"); expect(m.loadModelSettings()).toBe(cached);
    // 内容先写入同目录的暂存文件，再原子改名到目标路径。
    expect(String(io.write.mock.calls.at(-1)?.[0])).toMatch(/^E:\/synthetic\/model-settings\.json\..+\.tmp$/);
    expect(io.rename.mock.calls.at(-1)?.[1]).toBe("E:/synthetic/model-settings.json");
  });
  it("does not update the cached settings when persistence throws", () => {
    disk({ schemaVersion: 2, modelProfiles: [], provider: "Custom", model: "old" });
    const cached = m.loadModelSettings(); io.write.mockImplementation(() => { throw new Error("disk full"); });
    expect(() => m.saveModelSettings({ model: "new" })).toThrow(/^disk full$/);
    expect(cached.model).toBe("old");
  });
  it("preserves, replaces and explicitly clears input modality declarations", () => {
    disk({ schemaVersion: 2, modelProfiles: [], provider: "Custom", perProvider: { Custom: { ...profile, inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" } } });
    expect(m.saveModelSettings({ stickerEnabled: true })).toMatchObject({ inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api", multimodal: true });
    expect(m.saveModelSettings({ inputModalities: ["text"], inputModalitiesSource: "user" })).toMatchObject({ inputModalities: ["text"], inputModalitiesSource: "user", multimodal: false });
    expect(m.saveModelSettings({ inputModalities: undefined })).toMatchObject({ inputModalities: undefined, inputModalitiesSource: undefined, multimodal: false });
  });
  it("folds reasoning with per-provider precedence and preserves it on unrelated saves", () => {
    disk({ schemaVersion: 2, modelProfiles: [], provider: "Custom", perProvider: { Custom: { ...profile, reasoning: { mode: "on", effort: "high" } } } });
    expect(m.saveModelSettings({ stickerEnabled: true }).reasoning).toEqual({ mode: "on", effort: "high" });
    expect(m.saveModelSettings({ reasoning: { mode: "off" } }).reasoning).toEqual({ mode: "off" });
    expect(m.saveModelSettings({ reasoning: { mode: "off" }, perProvider: { Custom: { ...profile, reasoning: { mode: "on", effort: "low" } } } }).reasoning).toEqual({ mode: "on", effort: "low" });
  });
  it.each(["openai", "anthropic", "responses"] as const)("saves explicit transport %s", explicitTransport => {
    m.loadModelSettings();
    expect(m.saveModelSettings({ provider: "Custom", explicitTransport }).explicitTransport).toBe(explicitTransport);
  });
  it("adds the first profile as default, deduplicates credentials and generates IDs", () => {
    const first = m.saveModelProfile(profile);
    expect(first.added).toBe(true);
    expect(first.settings.defaultModelProfileId).toBe("p1");
    expect(m.resolveModelSettingsProfile(first.settings).model).toBe("fixture");
    const writes = io.write.mock.calls.length;
    expect(m.saveModelProfile({ ...profile, id: "duplicate" }).added).toBe(false);
    expect(io.write).toHaveBeenCalledTimes(writes);
    const { id: _id, ...withoutId } = profile;
    const second = m.saveModelProfile({ ...withoutId, model: "second" });
    expect(second.settings.modelProfiles?.at(-1)?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.settings.defaultModelProfileId).toBe("p1");
  });
  it("updates existing IDs and accepts a previously deleted ID as a new profile", () => {
    m.saveModelProfile(profile);
    const updated = m.saveModelProfile({ ...profile, model: "replacement" });
    expect(updated.added).toBe(true); expect(updated.settings.modelProfiles).toHaveLength(1);
    expect(updated.settings.modelProfiles?.[0].model).toBe("replacement");
    expect(m.saveModelProfile({ ...profile, id: "deleted", model: "new" }).settings.modelProfiles?.map(p => p.id)).toEqual(["p1", "deleted"]);
  });
  it("changes the default and rejects a missing profile with the exact error", () => {
    m.saveModelProfile(profile); m.saveModelProfile({ ...profile, id: "p2", model: "second" });
    expect(m.setDefaultModelProfile("p2")).toMatchObject({ defaultModelProfileId: "p2", model: "second" });
    expect(() => m.setDefaultModelProfile("missing")).toThrow(/^模型不存在$/);
  });
  it("returns detached narrow cached profiles without IO or fallback", () => {
    expect(m.getCachedSavedModelProfile("p1")).toBeUndefined(); expect(m.listCachedSavedModelProfileIds()).toEqual([]);
    disk({ schemaVersion: 2, modelProfiles: [profile] }); m.loadModelSettings();
    const reads = io.read.mock.calls.length;
    const cached = m.getCachedSavedModelProfile("p1")!; cached.apiKey = "changed";
    expect(m.getCachedSavedModelProfile("p1")).toEqual(profile);
    expect(m.getCachedSavedModelProfile("missing")).toBeUndefined();
    const ids = m.listCachedSavedModelProfileIds(); ids.push("other");
    expect(m.listCachedSavedModelProfileIds()).toEqual(["p1"]); expect(io.read).toHaveBeenCalledTimes(reads);
  });
});

describe("diagnostic source guards", () => {
  it("prepares once, reads the supplied source path, and refuses all writes", () => {
    disk({ schemaVersion: 2, modelProfiles: [profile] });
    expect(m.prepareReadOnlyDiagnosticModelCache(source)).toBe(true);
    expect(io.read.mock.calls[0][0].replaceAll("\\", "/")).toBe("E:/synthetic/Firefly/model-settings.json");
    expect(m.getCachedSavedModelProfile("p1")).toEqual(profile);
    expect(() => m.prepareReadOnlyDiagnosticModelCache(source)).toThrow(/^DIAGNOSTIC_SOURCE_REFUSED$/);
    expect(() => m.saveModelSettings({})).toThrow(/^DIAGNOSTIC_READ_ONLY$/);
    expect(io.write).not.toHaveBeenCalled();
  });
  it("reports failed preparation and keeps the source read-only", () => {
    io.stat.mockReturnValue({ size: 1 }); io.read.mockReturnValue("invalid");
    expect(m.prepareReadOnlyDiagnosticModelCache(source)).toBe(false);
    expect(() => m.assertModelSettingsReadable()).toThrow(/^DIAGNOSTIC_READ_ONLY$/);
  });
  it.each([{ ...source, kind: "smoke" }, { ...source, isolationRoot: "E:/synthetic" }])("rejects isolated/nonproduction sources", invalid => {
    expect(() => m.prepareReadOnlyDiagnosticModelCache(invalid as typeof source)).toThrow(/^DIAGNOSTIC_SOURCE_REFUSED$/);
    expect(io.read).not.toHaveBeenCalled();
  });
  it("rejects preparation after the normal cache is loaded", () => {
    m.loadModelSettings();
    expect(() => m.prepareReadOnlyDiagnosticModelCache(source)).toThrow(/^DIAGNOSTIC_SOURCE_REFUSED$/);
  });
});

describe("public config and connection facade", () => {
  it("maps provider short names, handles custom names and never exposes credentials", () => {
    for (const [provider, shortName] of [["DeepSeek（深度求索）", "DeepSeek"], ["ChatGPT（OpenAI）", "ChatGPT"], ["Custom", "Custom"]]) {
      const view = m.getPublicModelConfig(m.normalizeModelSettings({ provider, ...{ model: "fixture", apiKey: "secret" } }));
      expect(view).toMatchObject({ provider, shortName, connected: false });
      expect(view).not.toHaveProperty("apiKey"); expect(view).not.toHaveProperty("baseUrl");
    }
  });
  it("tests a saved profile with normalized config and publishes connection state", async () => {
    disk({ schemaVersion: 2, modelProfiles: [profile], defaultModelProfileId: "p1" });
    const states: string[] = [];
    const unsubscribe = m.onModelConnectionChanged(snapshot => { states.push(snapshot.profiles[0]?.state ?? "empty"); });
    expect(m.getModelConnectionSnapshot()).toMatchObject({ defaultProfileId: "p1", profiles: [{ profileId: "p1", state: "unverified", configured: true }] });
    const driver = vi.fn<Parameters<typeof m.testModelConnection>[1]>(async () => ({ ok: true, latency: 12 }));
    expect(await m.testModelConnection({ ...profile, baseUrl: ` ${profile.baseUrl} ` }, driver)).toEqual({ ok: true, latency: 12 });
    expect(driver.mock.calls[0][0]).toEqual({ provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey, explicitTransport: "openai" });
    expect(states).toEqual(["unverified", "checking", "connected"]);
    expect(m.getPublicModelConfig().connected).toBe(true);
    unsubscribe();
    await m.testModelConnection(profile, async () => ({ ok: false, latency: 1, error: "private detail" }));
    expect(states).toEqual(["unverified", "checking", "connected"]);
    expect(m.getPublicModelConfig().connected).toBe(false);
  });
  it("rejects invalid connection configs before invoking the driver", () => {
    const driver = vi.fn();
    expect(() => m.testModelConnection({}, driver)).toThrow(/^MODEL_CONNECTION_INVALID_CONFIG$/);
    expect(driver).not.toHaveBeenCalled();
  });
});
