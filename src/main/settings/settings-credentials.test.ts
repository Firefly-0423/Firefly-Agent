import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "", available: true, encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory }, safeStorage: {
  isEncryptionAvailable: () => state.available, encryptString: state.encrypt, decryptString: state.decrypt,
} }));
vi.mock("../logging/logger", () => ({ logger: { warn: vi.fn() }, LogTag: { Runtime: "runtime" } }));
beforeEach(() => {
  vi.resetModules();
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-settings-credentials-"));
  state.available = true;
  state.encrypt.mockReset().mockImplementation((text: string) => Buffer.from(`encrypted:${text}`));
  state.decrypt.mockReset().mockImplementation((bytes: Buffer) => {
    if (!bytes.toString().startsWith("encrypted:")) throw new Error("cannot decrypt");
    return bytes.toString().slice(10);
  });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(state.directory, { recursive: true, force: true }); });

for (const kind of ["model", "general"] as const) describe(`${kind} encrypted settings`, () => {
  const filename = kind === "model" ? "model-settings.json" : "app-settings.json";
  const legacy = kind === "model" ? {
    schemaVersion: 2, provider: "fixture", apiKey: "top-secret",
    perProvider: { fixture: { apiKey: "provider-secret", baseUrl: "https://example.test", model: "fixture" } },
    modelProfiles: [{ id: "profile", provider: "fixture", apiKey: "profile-secret", model: "fixture" }],
  } : {
    emailSmtpUser: "mail-user", emailSmtpPass: "mail-pass", asrMosslandKey: "asr-secret",
    asrAliyunAppKey: "app-key", asrAliyunAccessKeyId: "access-id", asrAliyunAccessKeySecret: "access-secret",
    ttsMosslandKey: "legacy-asr-secret", amapKey: "map-secret", searchBochaKey: "bocha-secret",
    searchTavilyKey: "tavily-secret", searchMinimaxKey: "minimax-secret", searchAnySearchKey: "search-secret",
  };
  async function store() {
    if (kind === "model") {
      const m = await import("./model-settings");
      return { load: m.loadModelSettings, save: () => m.saveModelSettings({}), assert: m.assertModelSettingsReadable };
    }
    const m = await import("./settings-facade");
    return { load: m.loadGeneralSettings, save: () => m.saveGeneralSettings({}), assert: m.assertGeneralSettingsReadable };
  }
  const secret = (value: unknown) => kind === "model"
    ? (value as { modelProfiles: { apiKey: string }[] }).modelProfiles[0].apiKey
    : (value as { emailSmtpPass: string }).emailSmtpPass;

  it("migrates legacy secrets, keeps unknown data and serves plaintext only in Main memory", async () => {
    const file = path.join(state.directory, filename);
    fs.writeFileSync(file, JSON.stringify({ ...legacy, unknown: "preserved" }));
    const m = await store();
    expect(secret(m.load())).toBe(kind === "model" ? "profile-secret" : "mail-pass");
    const disk = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(disk);
    expect(parsed.unknown).toBe("preserved");
    if (kind === "model") {
      for (const value of [parsed.apiKey, parsed.perProvider.fixture.apiKey, parsed.modelProfiles[0].apiKey]) {
        expect(value).toMatchObject({ $safeStorage: 1 });
      }
    } else {
      for (const key of Object.keys(legacy)) expect(parsed[key]).toMatchObject({ $safeStorage: 1 });
    }
    m.save();
    vi.resetModules();
    expect(secret((await store()).load())).toBe(kind === "model" ? "profile-secret" : "mail-pass");
  });

  it("supports plaintext fallback, then encrypts on the next save without changing runtime values", async () => {
    state.available = false;
    const file = path.join(state.directory, filename);
    fs.writeFileSync(file, JSON.stringify(legacy));
    const m = await store();
    const expected = secret(m.load());
    m.save();
    expect(secret(JSON.parse(fs.readFileSync(file, "utf8")))).toBe(expected);
    state.available = true;
    m.save();
    expect(secret(JSON.parse(fs.readFileSync(file, "utf8")))).toMatchObject({ $safeStorage: 1 });
    expect(secret(m.load())).toBe(expected);
  });

  it.each(["unavailable", "corrupt"])("preserves an encrypted file and blocks writes when %s", async (failure) => {
    const file = path.join(state.directory, filename);
    fs.writeFileSync(file, JSON.stringify(legacy));
    (await store()).load();
    const original = fs.readFileSync(file, "utf8");
    vi.resetModules();
    if (failure === "unavailable") state.available = false;
    else state.decrypt.mockImplementation(() => { throw new Error("cannot decrypt"); });
    const m = await store();
    expect(m.assert).toThrow(kind === "model" ? "MODEL_SETTINGS_READ_FAILED" : "GENERAL_SETTINGS_READ_FAILED");
    expect(m.save).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("cannot downgrade encrypted disk credentials after safeStorage becomes unavailable with a warm cache", async () => {
    const file = path.join(state.directory, filename);
    fs.writeFileSync(file, JSON.stringify(legacy));
    const m = await store();
    const before = JSON.stringify(m.load());
    const original = fs.readFileSync(file, "utf8");
    state.available = false;
    expect(m.save).toThrow("CREDENTIAL_STORAGE_UNREADABLE");
    expect(JSON.stringify(m.load())).toBe(before);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("does not update the cache or disk after encryption fails during save", async () => {
    fs.writeFileSync(path.join(state.directory, filename), JSON.stringify(legacy));
    const m = await store();
    const before = JSON.stringify(m.load());
    const original = fs.readFileSync(path.join(state.directory, filename), "utf8");
    state.encrypt.mockImplementation(() => { throw new Error("encryption failed"); });
    expect(m.save).toThrow();
    expect(JSON.stringify(m.load())).toBe(before);
    expect(fs.readFileSync(path.join(state.directory, filename), "utf8")).toBe(original);
  });
});

it("keeps explicit diagnostic model preparation read-only even when migration is available", async () => {
  const original = JSON.stringify({ schemaVersion: 2, modelProfiles: [{ id: "diagnostic", provider: "test", apiKey: "diagnostic-secret" }] });
  const file = path.join(state.directory, "model-settings.json");
  fs.writeFileSync(file, original);
  const m = await import("./model-settings");
  expect(m.prepareReadOnlyDiagnosticModelCache({ kind: "production", userData: state.directory } as never)).toBe(true);
  expect(m.getCachedSavedModelProfile("diagnostic")?.apiKey).toBe("diagnostic-secret");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(state.encrypt).not.toHaveBeenCalled();
});

it("encrypts credentials when persisting the installer's login choice without dropping retired fields", async () => {
  const file = path.join(state.directory, "app-settings.json");
  fs.writeFileSync(file, JSON.stringify({ emailSmtpPass: "mail-pass", retired: true }));
  fs.writeFileSync(path.join(state.directory, "installer-options.json"), '{"launchAtLogin":true}');
  const m = await import("./settings-facade");
  expect(m.loadGeneralSettings()).toMatchObject({ emailSmtpPass: "mail-pass", launchAtLogin: true });
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ retired: true, launchAtLogin: true, emailSmtpPass: { $safeStorage: 1 } });
});
