import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ports = vi.hoisted(() => ({
  root: "",
  source: "",
  sync: vi.fn(() => ({ installed: [], updated: [], preserved: [] })),
  validate: vi.fn(),
  register: vi.fn(),
  tools: vi.fn(),
  warn: vi.fn(),
  sources: [] as { directory: string; source: string }[],
}));
vi.mock("electron", () => ({ app: { getPath: () => ports.root } }));
vi.mock("../storage/external-content-paths", () => ({
  getExternalContentPaths: () => ({ userSkillDirectories: [ports.root] }),
  resolvePackagedSkillDirectory: () => ports.source || null,
  resolveSkillScanSources: () => ports.sources.length ? ports.sources : [{ directory: ports.root, source: "user" }],
}));
vi.mock("./directory-install", () => ({
  synchronizeManagedSkillDirectories: ports.sync,
  validateManagedSourceDirectory: ports.validate,
}));
vi.mock("./skill-scanner", async (importOriginal) => ({ ...await importOriginal<typeof import("./skill-scanner")>(), scanSkills: (_directory: string, source: string) => source === "builtin" ? [{ id: "built-skill", enabled: true, source }]
  : [{ id: "public-skill", enabled: true }, ...(ports.sources.length ? [{ id: "built-skill", enabled: true, source }] : [])] }));
vi.mock("./skill-registry", () => ({ skillRegistry: { register: ports.register, getAll: () => [], setExternalAccessGate: vi.fn(), unregister: vi.fn() } }));
vi.mock("./skill-tools", () => ({ registerSkillTools: ports.tools }));
vi.mock("../logging/logger", () => ({ logger: { info: vi.fn(), warn: ports.warn }, LogTag: { Skills: "Skills" } }));
import { createStorageContext } from "../storage/storage-context";
import { initSkills, shippedSkillIds } from "./index";

function storage() { return createStorageContext({ kind: "test", applicationName: "Firefly-test", appData: ports.root, userData: ports.root, sessionData: path.join(ports.root, "session"), logs: path.join(ports.root, "logs"), isolationRoot: ports.root }); }

function fixture() {
  ports.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-init-directory-")));
  ports.source = path.join(ports.root, "package", "skills");
  fs.mkdirSync(ports.source, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(ports.source), "skills-manifest.json"), JSON.stringify({ skills: ["public-skill"], files: {} }));
}

afterEach(() => {
  if (ports.root) fs.rmSync(ports.root, { recursive: true, force: true });
  ports.root = "";
  ports.source = "";
  ports.sources = [];
  vi.clearAllMocks();
});

it("rejects an invalid directory manifest without installing or replacing existing Skills", async () => {
  fixture();
  fs.writeFileSync(path.join(path.dirname(ports.source), "skills-manifest.json"), "{}");
  await initSkills(storage());
  expect(ports.sync).not.toHaveBeenCalled();
  expect(ports.register).toHaveBeenCalledWith({ id: "public-skill", enabled: true });
  expect(ports.warn).toHaveBeenCalled();
});

it("runs managed directory sync before scanning and preserves existing Skills after failure", async () => {
  fixture();
  ports.sync.mockImplementationOnce(() => { throw new Error("SKILL_UPDATE_BACKUP_CONFLICT"); });
  await expect(initSkills(storage())).resolves.toBeUndefined();
  expect(ports.validate).toHaveBeenCalledWith(ports.source, ["public-skill"], {});
  expect(ports.sync).toHaveBeenCalledOnce();
  expect(ports.register).toHaveBeenCalledWith({ id: "public-skill", enabled: true });
  expect(ports.tools).toHaveBeenCalledOnce();
  expect(ports.warn).toHaveBeenCalled();
  expect(JSON.stringify(ports.warn.mock.calls)).not.toContain(ports.root);
});

it("synchronizes a valid source without adding it to the scan roots", async () => {
  fixture();
  await initSkills(storage());
  expect(ports.sync).toHaveBeenCalledWith({ sourceDirectory: ports.source, userSkillsDir: path.join(ports.root, "skills"),
    expectedIds: ["public-skill"], expectedFileHashes: {} });
  expect(ports.register).toHaveBeenCalledTimes(1);
});

it("counts the installer's managed Skills as shipped once they are synchronized, so the market never installs a second copy", async () => {
  fixture();
  await initSkills(storage());
  expect([...shippedSkillIds()]).toEqual(["public-skill"]);
  fs.writeFileSync(path.join(path.dirname(ports.source), "skills-manifest.json"), "{}");
  await initSkills(storage());
  expect([...shippedSkillIds()]).toEqual([]);
});

it("keeps a built-in Skill shipped when a user Skill of the same id overrides it", async () => {
  fixture();
  ports.sources = [{ directory: path.join(ports.root, "builtin"), source: "builtin" }, { directory: ports.root, source: "user" }];
  await initSkills(storage());
  // The user copy wins in the registry, but the market must still treat the id as shipped.
  expect(ports.register).toHaveBeenCalledWith({ id: "built-skill", enabled: true, source: "user" });
  expect([...shippedSkillIds()].sort()).toEqual(["built-skill", "public-skill"]);
});
