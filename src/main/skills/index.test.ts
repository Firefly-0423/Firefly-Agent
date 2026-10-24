import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ scan: vi.fn(), external: vi.fn(), read: vi.fn(), write: vi.fn(), record: vi.fn(), setOwned: vi.fn(), assertWritable: vi.fn(), verify: vi.fn(), identity: vi.fn(), packaged: vi.fn(), readFile: vi.fn(), validate: vi.fn(), sync: vi.fn(), tools: vi.fn() }));
vi.mock("./skill-scanner", () => ({ scanSkills: deps.scan, isExternalSkillId: (id: string) => typeof id === "string" && id.startsWith("external-"), externalSkillPlaceholder: (id: string, dirPath: string) => ({ id, dirPath, enabled: false, external: { status: "reimport-required" } }) }));
vi.mock("./skill-tools", () => ({ registerSkillTools: deps.tools }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { Skills: "skills" } }));
vi.mock("../external-content-paths", () => ({ getExternalContentPaths: () => ({}), resolveSkillScanSources: () => [{ directory: "builtin", source: "builtin" }, { directory: "user", source: "user" }], resolvePackagedSkillDirectory: deps.packaged }));
vi.mock("./directory-install", () => ({ validateManagedSourceDirectory: deps.validate, synchronizeManagedSkillDirectories: deps.sync }));
vi.mock("../storage-context", () => ({ getStorageContext: () => ({ configRoot: "config", dataRoot: "data" }) }));
vi.mock("../atomic-json-store", () => ({ AtomicJsonStore: class { read = deps.read; write = deps.write; } }));
vi.mock("./external-state", () => ({ ExternalSkillStateStore: class { read = deps.record; setEnabledOwned = deps.setOwned; assertWritable = deps.assertWritable; }, verifyExternalInstallation: deps.verify, assertExternalIdentity: deps.identity }));
vi.mock("./external-scan", () => ({ scanExternalSkills: deps.external }));
vi.mock("fs", () => ({ readFileSync: deps.readFile }));
const skill = (id: string, extra: object = {}) => ({ id, name: id, description: "description", enabled: true, references: [], source: "builtin", dirPath: "dir", bodyPath: "dir/SKILL.md", ...extra });
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); deps.scan.mockReturnValue([]); deps.external.mockReturnValue([]); deps.read.mockReturnValue({}); deps.packaged.mockReturnValue(undefined); deps.verify.mockReturnValue([]); });
afterEach(() => vi.restoreAllMocks());
it("requires initialization before mutation or rescan", async () => { const api = await import("./index"); expect(() => api.rescanSkills()).toThrow(/^SKILL_STORAGE_NOT_INITIALIZED$/); expect(() => api.setSkillEnabled("a", true)).toThrow(/^SKILL_STORAGE_NOT_INITIALIZED$/); });
it("merges sources with user precedence and persisted enablement, then removes stale entries on rescan", async () => {
  const api = await import("./index"); deps.scan.mockImplementation((directory: string) => directory === "builtin" ? [skill("a"), skill("old")] : [skill("a", { name: "override", source: "user" })]); deps.read.mockReturnValue({ a: false }); await api.initSkills(); expect(api.skillRegistry.getById("a")).toMatchObject({ name: "override", enabled: false }); expect(deps.tools).toHaveBeenCalledOnce(); deps.scan.mockReturnValue([]); expect(api.rescanSkills()).toBe(0); expect(api.skillRegistry.getAll()).toEqual([]);
});
it("projects visible UI metadata with default tools without exposing paths", async () => {
  const api = await import("./index"); deps.scan.mockImplementation((directory: string) => directory === "builtin" ? [skill("a"), skill("hidden", { hiddenFromUi: true })] : []); await api.initSkills(); expect(api.listSkillsForUi()).toEqual([{ id: "a", name: "a", description: "description", enabled: true, tools: [], source: "builtin", references: [], version: undefined, external: undefined }]);
});
it("persists enablement before changing registry state and retains unrelated preferences", async () => {
  const api = await import("./index"); deps.scan.mockReturnValue([skill("a")]); deps.read.mockReturnValue({ old: true }); await api.initSkills(); deps.write.mockImplementation((saved: unknown) => { expect(api.skillRegistry.getById("a")?.enabled).toBe(true); expect(saved).toEqual({ old: true, a: false }); }); api.setSkillEnabled("a", false); expect(api.skillRegistry.getById("a")?.enabled).toBe(false);
});
it("does not advertise failed persistence", async () => {
  const api = await import("./index"); deps.scan.mockReturnValue([skill("a")]); await api.initSkills(); deps.write.mockImplementation(() => { throw Error("disk"); }); expect(() => api.setSkillEnabled("a", false)).toThrow(/^disk$/); expect(api.skillRegistry.getById("a")?.enabled).toBe(true);
});
it.each([["missing", true], ["a", "yes"]])("rejects invalid enable arguments %s/%s", async (id, enabled) => {
  const api = await import("./index"); deps.scan.mockReturnValue([skill("a")]); await api.initSkills(); expect(() => api.setSkillEnabled(id as string, enabled as boolean)).toThrow(/^SKILL_ENABLE_ARGUMENT_INVALID$/); expect(deps.write).not.toHaveBeenCalled();
});
it("validates the packaged manifest before synchronization", async () => {
  deps.packaged.mockReturnValue(path.join("package", "skills")); const manifest = { skills: ["a"], files: { "a/SKILL.md": "hash" } }; deps.readFile.mockReturnValue(JSON.stringify(manifest)); const api = await import("./index"); await api.initSkills(); expect(deps.validate).toHaveBeenCalledWith(path.join("package", "skills"), manifest.skills, manifest.files); expect(deps.sync).toHaveBeenCalledWith({ sourceDirectory: path.join("package", "skills"), userSkillsDir: path.join("data", "skills"), expectedIds: manifest.skills, expectedFileHashes: manifest.files });
});
it.each(["bad json", '{"skills":[],"files":[]}', '{"files":{}}'])("continues scanning after invalid packaged manifest %s", async raw => {
  deps.packaged.mockReturnValue("package/skills"); deps.readFile.mockReturnValue(raw); deps.scan.mockReturnValue([skill("existing")]); const api = await import("./index"); await api.initSkills(); expect(api.skillRegistry.getById("existing")).toBeDefined(); expect(deps.sync).not.toHaveBeenCalled();
});
it("checks external provenance before enablement and rejects a changed record on rescan", async () => {
  const api = await import("./index"), id = "external-a", dirPath = path.join("data", "skills", id, "content"); const entry = skill(id, { dirPath, bodyPath: path.join(dirPath, "SKILL.md"), external: { status: "ready" }, source: "user" }); const record = { status: "committed", transactionId: "tx", enabled: true };
  deps.external.mockReturnValue([entry]); deps.record.mockReturnValue(record); await api.initSkills(); api.setSkillEnabled(id, false); expect(deps.setOwned).toHaveBeenCalledWith(id, "tx", false); expect(deps.verify).toHaveBeenCalled(); deps.record.mockReturnValue({ ...record, transactionId: "changed" }); api.rescanSkills(); expect(api.skillRegistry.getById(id)).toMatchObject({ enabled: false, external: { status: "reimport-required" } }); expect(() => api.setSkillEnabled(id, true)).toThrow(/^SKILL_EXTERNAL_UNAVAILABLE$/);
});
