import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createStorageContext } from "../storage/storage-context";
import { AtomicJsonStore } from "../storage/atomic-json-store";
import { ExternalSkillStateStore } from "./external-state";
import { externalSkillId } from "./external-policy";
import { digestExternalFiles } from "./external-review";
import { stageExternalSkill, commitExternalSkill } from "./external-install";
import type { ExternalHostSession, ExternalSkillRecord } from "./external-types";
import type { IpcScope } from "../application/ipc-scope";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { IPC } from "../../shared/ipc-channels";
const ports = vi.hoisted(() => ({ root: "", chat: null as null | { isDestroyed: () => boolean; webContents: { isDestroyed: () => boolean; mainFrame: { processId: number; routingId: number; detached: boolean } } } }));
vi.mock("electron", () => ({ dialog: {}, app: { isPackaged: false, getAppPath: () => "/unused", getPath: () => ports.root } }));
vi.mock("../storage/external-content-paths", () => ({ getExternalContentPaths: () => ({ installRoot: "/unused", builtinSkillDirectory: "/unused", userSkillDirectories: [path.join(ports.root, "skills")] }), resolvePackagedSkillDirectory: () => null,
  resolveSkillScanSources: (paths: { userSkillDirectories: string[] }) => paths.userSkillDirectories.map(directory => ({ directory, source: "user" })) }));
vi.mock("../memory/memory-store", () => ({ memoryStore: {} }));
vi.mock("../memory/panel", () => ({ loadImportedDocumentPanelData: vi.fn(), loadMemoryPanelData: vi.fn() }));
vi.mock("../storage/settings-store", () => ({ loadUserProfile: vi.fn(), saveUserProfile: vi.fn(), getAvatarPath: vi.fn() }));
vi.mock("../orchestrator/sticker-settings", () => ({ getStickerManagerConfig: vi.fn(), setStickerEnabled: vi.fn() }));
vi.mock("../stickers/sticker-storage", () => ({ addUserSticker: vi.fn(), deleteUserSticker: vi.fn() }));
vi.mock("../rag", () => ({ deleteImportedDoc: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({ addMcpServer: vi.fn(), removeMcpServer: vi.fn(), listMcpServers: vi.fn() }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: vi.fn(), saveGeneralSettings: vi.fn() }));
vi.mock("../windows/window-state", () => ({ get reactChatWindow() { return ports.chat; }, sidebarWindow: null, settingsWindow: null, stickerManagerWindow: null }));
vi.mock("../memory/obsidian-exporter", () => ({ exportMemoryToObsidianVault: vi.fn(), syncToBoundVault: vi.fn() }));
vi.mock("../memory/obsidian-vault-config", () => ({ loadObsidianVaultConfig: vi.fn(), saveObsidianVaultConfig: vi.fn(), unbindVault: vi.fn() }));
vi.mock("../memory/obsidian-importer", () => ({ startVaultWatcher: vi.fn(), stopVaultWatcher: vi.fn() }));
import { initSkills, rescanSkills, setSkillEnabled, skillRegistry } from "./index";
import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const skill of skillRegistry.getAll()) skillRegistry.unregister(skill.id); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
async function fixture(imported = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-t6-scan-test-"))); roots.push(root);
  const userData = path.join(root, "Firefly-test"); fs.mkdirSync(userData); ports.root = userData;
  const storage = createStorageContext({ kind: "test", applicationName: "Firefly-test", appData: root, userData, sessionData: path.join(userData, "session"), logs: path.join(userData, "logs"), isolationRoot: root });
  let primary = true;
  const host: ExternalHostSession = { runId: randomUUID(), isPrimaryProcess: () => primary };
  const prefix = "plugins/synthetic/skills/text", secret = "T6_INSTRUCTION_SENTINEL";
  const body = Buffer.from(`---\nname: text\ndescription: Synthetic.\nhiddenFromUi: true\ntools: [unsafe_tool]\nallowed-tools: [unsafe_tool]\ndefaultEnabled: true\nautoInject: true\n---\n${secret}\n## Soul 回复策略\n${secret}\n`);
  const payload = new Map([[prefix + "/SKILL.md", body], [prefix + "/LICENSE", Buffer.from("Synthetic MIT terms.\n")], [prefix + "/references/info.md", Buffer.from(secret + " reference")]]);
  const files = [...payload].map(([location, bytes]) => ({ path: location, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), blobSha1: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") }));
  const id = externalSkillId("openai", "openai/plugins", prefix);
  const record: ExternalSkillRecord = { schema: 1, id, transactionId: randomUUID(), status: "prepared", enabled: false, contentSha256: digestExternalFiles(files), skill: { id, sourceId: "openai", upstreamName: "text", description: "Synthetic.", repository: "openai/plugins", path: prefix, commit: "a".repeat(40), bundle: { name: "synthetic", version: "9.0", license: "MIT" }, files, licenses: [{ path: prefix + "/LICENSE", sha256: files[1].sha256, spdx: "MIT", covers: files.map(file => file.path) }], review: "approved", blockers: [] } };
  const state = new ExternalSkillStateStore(storage, host);
  if (imported) { const stage = stageExternalSkill(storage, record, payload); await commitExternalSkill({ storage, state, record, stageRoot: stage.stageRoot }); }
  return { root, storage, host, state, record, secret, body, id, outer: path.join(userData, "skills", id), file: path.join(userData, "external-skills", id + ".json"), primary: (next: boolean) => { primary = next; } };
}

function invoke() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc: IpcScope = { handle: (name, handler) => { handlers.set(name, handler); }, on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() };
  registerMemoryUserToolIpc({ windowManager: null, embeddingIndexService: {} as EmbeddingIndexService, ipc, personalMemoryMode: "smh" });
  const mainFrame = { processId: 1, routingId: 2, detached: false };
  const sender = { isDestroyed: () => false, mainFrame };
  ports.chat = { isDestroyed: () => false, webContents: sender };
  return (payload: unknown) => handlers.get(IPC.SKILL_SET_ENABLED)!({ sender, senderFrame: mainFrame }, payload);
}

it("persist_before_enable propagates AtomicJsonStore failure through real IPC without changing disk or registry", async () => {
  const f = await fixture(); await initSkills(f.storage, f.host); const before = fs.readFileSync(f.file);
  const failure = vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(() => { throw new Error("Synthetic write failure " + f.root); });
  expect(() => setSkillEnabled(f.id, true)).toThrow();
  expect(skillRegistry.getById(f.id)?.enabled).toBe(false);
  expect(invoke()({ id: f.id, enabled: true })).toMatchObject({ ok: false });
  expect(failure).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(invoke()({ id: f.id, enabled: true }))).not.toContain(f.root);
  expect(fs.readFileSync(f.file)).toEqual(before); expect(f.state.read(f.id)?.enabled).toBe(false);
  failure.mockRestore(); await initSkills(f.storage, { ...f.host, runId: randomUUID() });
  expect(skillRegistry.getById(f.id)?.enabled).toBe(false); expect(skillRegistry.getBody(f.id)).toBeNull();
});

it("persist_before_enable changes registry only after persisted state and survives refresh and restart", async () => {
  const f = await fixture(), legacy = path.join(f.storage.configRoot, "skills-enabled.json"); fs.writeFileSync(legacy, JSON.stringify({ [f.id]: false })); const legacyBefore = fs.readFileSync(legacy); await initSkills(f.storage, f.host);
  const original = AtomicJsonStore.prototype.write;
  const written = vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(function(this: AtomicJsonStore<unknown>, value: unknown) {
    expect(skillRegistry.getById(f.id)?.enabled).toBe(false); original.call(this, value);
  });
  expect(invoke()({ id: f.id, enabled: true })).toEqual({ ok: true }); written.mockRestore();
  expect(fs.readFileSync(legacy)).toEqual(legacyBefore); expect(f.state.read(f.id)?.enabled).toBe(true); expect(skillRegistry.getById(f.id)?.enabled).toBe(true); expect(skillRegistry.getBody(f.id)).toContain(f.secret);
  expect(rescanSkills()).toBe(1); expect(skillRegistry.getBody(f.id)).toContain(f.secret);
  await initSkills(f.storage, { ...f.host, runId: randomUUID() }); expect(skillRegistry.getBody(f.id)).toContain(f.secret);
  setSkillEnabled(f.id, false); expect(f.state.read(f.id)?.enabled).toBe(false); expect(skillRegistry.getBody(f.id)).toBeNull();
});

it.each(["missing", "corrupt", "tampered", "secondary", "no-host"])("enable refuses invalid provenance or host: %s", async kind => {
  const f = await fixture(); await initSkills(f.storage, kind === "no-host" ? undefined : f.host);
  if (kind === "missing") fs.unlinkSync(f.file); if (kind === "corrupt") fs.writeFileSync(f.file, "{");
  if (kind === "tampered") fs.writeFileSync(path.join(f.outer, "content", "SKILL.md"), "changed"); if (kind === "secondary") f.primary(false);
  expect(invoke()({ id: f.id, enabled: true })).toMatchObject({ ok: false }); expect(skillRegistry.getById(f.id)?.enabled).toBe(false);
});

it.each([null, {}, { id: "missing", enabled: true }, { id: "missing" }, { id: "missing", enabled: "true" }, { id: 7, enabled: true }])("real IPC rejects malformed enable payload %j", async payload => {
  expect(invoke()(payload)).toMatchObject({ ok: false });
});

it("ordinary skills retain the injected legacy settings path and propagate write failures", async () => {
  const f = await fixture(false), directory = path.join(f.storage.dataRoot, "skills", "ordinary"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: ordinary\ndescription: Ordinary.\n---\nordinary body");
  const file = path.join(f.storage.configRoot, "skills-enabled.json"); fs.writeFileSync(file, JSON.stringify({ ordinary: false }));
  await initSkills(f.storage); expect(skillRegistry.getById("ordinary")?.bodyPath).toBe(path.join(directory, "SKILL.md"));
  const before = fs.readFileSync(file), failure = vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(() => { throw new Error("injected"); });
  expect(invoke()({ id: "ordinary", enabled: true })).toMatchObject({ ok: false }); expect(skillRegistry.getById("ordinary")?.enabled).toBe(false); expect(fs.readFileSync(file)).toEqual(before);
  failure.mockRestore(); expect(invoke()({ id: "ordinary", enabled: true })).toEqual({ ok: true }); expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ordinary: true });
  expect(skillRegistry.getBody("ordinary")).toBe("ordinary body");
});

it.each([undefined, "true", 1, null])("known Skill IPC rejects non-boolean enabled %j without persisting", async enabled => {
  const f = await fixture(); await initSkills(f.storage, f.host); const before = fs.readFileSync(f.file);
  expect(invoke()({ id: f.id, enabled })).toMatchObject({ ok: false }); expect(fs.readFileSync(f.file)).toEqual(before); expect(skillRegistry.getById(f.id)?.enabled).toBe(false);
});
