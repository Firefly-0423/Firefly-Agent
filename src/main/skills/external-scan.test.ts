import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createStorageContext } from "../storage-context";
import { ExternalSkillStateStore } from "./external-state";
import { externalSkillId } from "./external-policy";
import { digestExternalFiles } from "./external-review";
import { stageExternalSkill, commitExternalSkill } from "./external-install";
import type { ExternalHostSession, ExternalSkillRecord } from "./external-types";
import { SkillRegistry } from "./skill-registry";
import { scanSkills } from "./skill-scanner";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { registerSkillTools } from "./skill-tools";

const ports = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/unused", getPath: () => ports.root } }));
vi.mock("../external-content-paths", () => ({ getExternalContentPaths: () => ({ installRoot: "/unused", builtinSkillDirectory: "/unused", userSkillDirectories: [path.join(ports.root, "skills")] }), resolvePackagedSkillDirectory: () => null,
  resolveSkillScanSources: (paths: { userSkillDirectories: string[] }) => paths.userSkillDirectories.map(directory => ({ directory, source: "user" })) }));
import { initSkills, rescanSkills, setSkillEnabled, skillRegistry, listSkillsForUi, buildSkillCatalog, buildAutoInjectedSkillContext, buildAutoInjectedSoulContext } from "./index";
import { resolveSlashActivation } from "./slash-activation";
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

it("host_gates_before_registration reserves malformed prefixes without parsing upstream capabilities", async () => {
  const f = await fixture(false), directory = path.join(f.storage.dataRoot, "skills", "external-malformed"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), f.body);
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ id: "external-malformed", version: "1", defaultEnabled: true, entry: "SKILL.md", dependencies: ["unsafe_tool"], autoInject: true }));
  const scanned = scanSkills(path.dirname(directory), "user")[0];
  expect(scanned?.enabled).toBe(false); expect(scanned?.tools).toEqual([]); expect(scanned?.hiddenFromUi).toBe(false);
  expect(scanned?.manifest).toBeUndefined();
  const registry = new SkillRegistry(); registry.register({ ...scanned, enabled: true });
  expect(registry.getBody(scanned.id)).toBeNull(); expect(registry.getEnabled()).toEqual([]); expect(registry.isAvailable(scanned.id)).toBe(false);
});

it.each(["missing", "corrupt", "prepared", "changed-body"])("state_missing_or_corrupt %s remains visible and disabled despite legacy true", async kind => {
  const f = await fixture();
  if (kind === "missing") fs.unlinkSync(f.file);
  if (kind === "corrupt") fs.writeFileSync(f.file, "{");
  if (kind === "prepared") fs.writeFileSync(f.file, JSON.stringify(f.record));
  if (kind === "changed-body") fs.writeFileSync(path.join(f.outer, "content", "SKILL.md"), "untrusted");
  fs.writeFileSync(path.join(f.storage.configRoot, "skills-enabled.json"), JSON.stringify({ [f.id]: true }));
  await initSkills(f.storage, f.host);
  const entry = listSkillsForUi().find(skill => skill.id === f.id);
  expect(entry).toMatchObject({ enabled: false, tools: [], external: { status: "reimport-required" } });
  expect(skillRegistry.getBody(f.id)).toBeNull(); expect(skillRegistry.getReference(f.id, "info.md")).toBeNull();
});

it.each(["work", "code"] as const)("host_gates_before_registration blocks every real %s consumer despite true mode overrides", async mode => {
  const f = await fixture(); fs.writeFileSync(path.join(f.storage.configRoot, "skills-enabled.json"), JSON.stringify({ [f.id]: true })); await initSkills(f.storage, f.host);
  expect(skillRegistry.getById(f.id)).toMatchObject({ enabled: false, tools: [], hiddenFromUi: false, external: { status: "ready" } });
  expect(skillRegistry.getById(f.id)?.version).toBeUndefined();
  const overrides = { [f.id]: { work: true, code: true } };
  registerSkillTools();
  expect(skillRegistry.getEnabled()).toEqual([]); expect(skillRegistry.getEnabledForMode(mode, overrides)).toEqual([]);
  expect(buildSkillCatalog(skillRegistry.getEnabledForMode(mode, overrides))).toBe("");
  expect(buildAutoInjectedSkillContext(skillRegistry.getEnabled(), id => skillRegistry.getBody(id))).toBe("");
  expect(buildAutoInjectedSoulContext(skillRegistry.getEnabled(), id => skillRegistry.getBody(id))).toBe("");
  for (const [id, args] of [["invoke_skill", { skill_id: f.id }], ["read_skill_reference", { skill_id: f.id, ref: "info.md" }], ["read_skill_reference", { skill_id: f.id, source: "body", ref: "SKILL.md" }]] as const) expect(String(await toolRegistry.getById(id)!.execute(args, { userQuery: "test", allowedSkillIds: new Set([f.id]) }))).not.toContain(f.secret);
  expect(resolveSlashActivation([{ role: "user", content: "/" + f.id }], mode, overrides)).toBe("");
  expect(skillRegistry.getBody(f.id)).toBeNull(); expect(skillRegistry.getReference(f.id, "info.md")).toBeNull();
});

it.each(["missing-state", "corrupt-state", "changed-state", "body", "reference", "primary"])("registration and cache do not authorize later %s changes", async kind => {
  const f = await fixture(); await initSkills(f.storage, f.host); setSkillEnabled(f.id, true);
  expect(skillRegistry.getBody(f.id)).toContain(f.secret); expect(skillRegistry.getReference(f.id, "info.md")).toContain(f.secret);
  if (kind === "missing-state") fs.unlinkSync(f.file);
  if (kind === "corrupt-state") fs.writeFileSync(f.file, "{");
  if (kind === "changed-state") { const record = f.state.read(f.id)!; record.skill.commit = "b".repeat(40); fs.writeFileSync(f.file, JSON.stringify(record)); }
  if (kind === "body") fs.writeFileSync(path.join(f.outer, "content", "SKILL.md"), "changed");
  if (kind === "reference") fs.writeFileSync(path.join(f.outer, "content", "references", "info.md"), "changed");
  if (kind === "primary") f.primary(false);
  expect(skillRegistry.getBody(f.id)).toBeNull(); expect(skillRegistry.getReference(f.id, "info.md")).toBeNull();
  registerSkillTools();
  for (const [id, args] of [["invoke_skill", { skill_id: f.id }], ["read_skill_reference", { skill_id: f.id, ref: "info.md" }], ["read_skill_reference", { skill_id: f.id, source: "body", ref: "SKILL.md" }]] as const) expect(String(await toolRegistry.getById(id)!.execute(args, { userQuery: "test", allowedSkillIds: new Set([f.id]) }))).not.toContain(f.secret);
  expect(buildSkillCatalog(skillRegistry.getEnabled())).toBe("");
  expect(buildAutoInjectedSkillContext(skillRegistry.getEnabled(), id => skillRegistry.getBody(id))).toBe("");
  expect(buildAutoInjectedSoulContext(skillRegistry.getEnabled(), id => skillRegistry.getBody(id))).toBe("");
  expect(skillRegistry.isAvailable(f.id)).toBe(false); expect(skillRegistry.getEnabledForMode("code", { [f.id]: { code: true } })).toEqual([]);
  expect(resolveSlashActivation([{ role: "user", content: "/" + f.id }], "work", { [f.id]: { work: true } })).toBe("");
});

it("reinitializing a test profile clears its previous gate, metadata and body cache", async () => {
  const first = await fixture(); await initSkills(first.storage, first.host); setSkillEnabled(first.id, true); expect(skillRegistry.getBody(first.id)).toContain(first.secret);
  const second = await fixture(); await initSkills(second.storage); // same stable id, distinct profile, no host capability
  expect(skillRegistry.getById(second.id)?.enabled).toBe(false); expect(skillRegistry.getBody(second.id)).toBeNull();
  expect(() => setSkillEnabled(second.id, true)).toThrow();
  first.primary(false); expect(rescanSkills()).toBe(1); expect(skillRegistry.getBody(second.id)).toBeNull();
});

it("refresh cannot adopt changed provenance from an already registered transaction", async () => {
  const f = await fixture(); await initSkills(f.storage, f.host); setSkillEnabled(f.id, true);
  const record = f.state.read(f.id)!; record.skill.commit = "b".repeat(40); fs.writeFileSync(f.file, JSON.stringify(record));
  expect(rescanSkills()).toBe(1);
  expect(skillRegistry.getById(f.id)).toMatchObject({ enabled: false, external: { status: "reimport-required" } });
  expect(skillRegistry.getBody(f.id)).toBeNull(); expect(() => setSkillEnabled(f.id, true)).toThrow();
});

it.each(["empty", "link", "file", "bad-header", "case-alias"])("malformed external namespace %s remains visible without reading its body", async kind => {
  const f = await fixture(false), id = kind === "case-alias" ? "EXTERNAL-UNOWNED" : "external-unowned", directory = path.join(f.storage.dataRoot, "skills", id);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (kind === "link") { const target = path.join(f.root, "foreign"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "SKILL.md"), f.body); fs.symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir"); }
  else if (kind === "file") fs.writeFileSync(directory, f.body);
  else { fs.mkdirSync(directory); if (kind === "bad-header" || kind === "case-alias") fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nunsafe: [\n---\n" + f.secret); }
  await initSkills(f.storage, f.host);
  expect(listSkillsForUi()).toMatchObject([{ id, enabled: false, external: { status: "reimport-required" } }]);
  expect(skillRegistry.getBody(id)).toBeNull(); expect(skillRegistry.getById(id)?.description).not.toContain(f.secret);
});

it("a directly registered external Skill cannot read body or reference through permissive mode and availability probes", async () => {
  const f = await fixture(false), directory = path.join(f.root, "untrusted"); fs.mkdirSync(path.join(directory, "references"), { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), f.body); fs.writeFileSync(path.join(directory, "references", "info.md"), f.secret);
  const registry = new SkillRegistry(); registry.register({ id: f.id, name: "text", description: "display", source: "user", dirPath: directory, bodyPath: path.join(directory, "SKILL.md"), enabled: true, references: ["info.md"], external: { status: "ready" } });
  registry.setAvailability(f.id, () => true);
  expect(registry.getBody(f.id)).toBeNull(); expect(registry.getReference(f.id, "info.md")).toBeNull();
  expect(registry.getEnabled()).toEqual([]); expect(registry.getEnabledForMode("work", { [f.id]: { work: true } })).toEqual([]); expect(registry.isAvailable(f.id)).toBe(false);
});

it("an enabled committed record still cannot provide instructions without the current Main host", async () => {
  const f = await fixture(); await initSkills(f.storage, f.host); setSkillEnabled(f.id, true);
  await initSkills(f.storage);
  expect(skillRegistry.getById(f.id)?.enabled).toBe(true); // truthful persisted preference, runtime denied
  expect(skillRegistry.getEnabled()).toEqual([]); expect(skillRegistry.getBody(f.id)).toBeNull(); expect(skillRegistry.getReference(f.id, "info.md")).toBeNull();
});
