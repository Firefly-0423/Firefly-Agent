import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ExternalResult, ExternalSkillSourceId } from "../../shared/external-skills";
import type { ExternalOwner, ExternalServiceDeps, ExternalSkillReview } from "./external-types";
import { externalSkillId, EXTERNAL_LIMITS, EXTERNAL_SOURCES, EXTERNAL_REVIEW_POLICY_VERSION } from "./external-policy";
import { digestExternalFiles } from "./external-review";
import { ExternalSkillStateStore, ExternalStorageError } from "./external-state";
import * as install from "./external-install";
import { isolatedStorageContext, createExternalFixture } from "./testing/external-fixtures";

const modules = import.meta.glob<typeof import("./external-service")>("./external-service.ts");
const owner: ExternalOwner = { webContentsId: 1, frameProcessId: 2, frameRoutingId: 3, generation: 0 };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const run of cleanup.splice(0).reverse()) await run(); });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitHash = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function value<T>(result: ExternalResult<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(result.code); return result.value; }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise<void>(resolve => setImmediate(resolve)); expect(check()).toBe(true); }
function fixture(sourceId: ExternalSkillSourceId = "openai", extra: Record<string, string | Buffer> = {}) {
  const isolated = isolatedStorageContext(); cleanup.push(() => { isolated.dispose(); fs.rmSync(isolated.productionSentinelRoot, { recursive: true, force: true }); });
  const root = sourceId === "openai" ? "plugins/synthetic/skills/synthetic-text" : "skills/synthetic-text";
  const source = EXTERNAL_SOURCES[sourceId], commit = "a".repeat(40), treeSha = "b".repeat(40);
  const payload = new Map(Object.entries({ ...createExternalFixture().expectedFiles, ...extra }).map(([relative, text]) => [root + "/" + relative, Buffer.from(text)]));
  const files = [...payload].map(([path, bytes]) => ({ path, blobSha1: gitHash(bytes), sha256: hash(bytes), bytes: bytes.length }));
  const review: ExternalSkillReview = { policyVersion: EXTERNAL_REVIEW_POLICY_VERSION, sourceId, commit, path: root, contentSha256: digestExternalFiles(files),
    licenses: [{ path: root + "/LICENSE", sha256: hash(payload.get(root + "/LICENSE")!), spdx: "MIT", covers: files.map(file => file.path) }],
    compatibility: "instruction-only", reviewedAt: "2026-10-08T00:00:00.000Z", reviewer: "synthetic-only-service-test" };
  const catalog = sourceId === "openai" ? { plugins: [{ name: "synthetic", source: { source: "local", path: "./plugins/synthetic" } }] }
    : { plugins: [{ name: "synthetic", source: "./", skills: ["./" + root], license: "MIT", version: "bundle-9" }] };
  const meta = new Map<string, Buffer>([[source.catalogPath, Buffer.from(JSON.stringify(catalog))]]);
  if (sourceId === "openai") meta.set("plugins/synthetic/.codex-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "synthetic", skills: "./skills", license: "MIT", version: "bundle-9" })));
  const blobs = new Map([...meta, ...payload].map(([, bytes]) => [gitHash(bytes), bytes]));
  const tree = [...meta, ...payload].map(([path, bytes]) => ({ path, type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length }));
  const calls: string[] = [], signals: AbortSignal[] = [];
  const base = "https://api.github.com/repos/" + source.repository;
  const route: typeof globalThis.fetch = async input => {
    const url = String(input);
    if (url === base) return Response.json({ default_branch: "main" });
    if (url === base + "/commits/main") return Response.json({ sha: commit });
    if (url === base + "/git/commits/" + commit) return Response.json({ sha: commit, tree: { sha: treeSha } });
    if (url === base + "/git/trees/" + treeSha + "?recursive=1") return Response.json({ sha: treeSha, truncated: false, tree });
    const bytes = blobs.get(url.slice((base + "/git/blobs/").length));
    if (url.startsWith(base + "/git/blobs/") && bytes) return Response.json({ sha: gitHash(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
    return Response.json({}, { status: 404 }); // Never falls through to live HTTP.
  };
  let hook: typeof globalThis.fetch | undefined, now = 1000, primary = true;
  const deps: ExternalServiceDeps = { storage: isolated.storage, host: { runId: randomUUID(), isPrimaryProcess: () => primary },
    fetch: async (input, init) => { calls.push(String(input)); signals.push(init!.signal!); return (hook ?? route)(input, init); },
    now: () => now, randomToken: () => createHash("sha256").update(randomUUID()).digest("hex"), reviews: [review], rescan: () => 1 };
  return { ...isolated, root, sourceId, commit, review, payload, files, blobs, tree, meta, calls, signals, route, deps,
    id: externalSkillId(sourceId, source.repository, root), setNow: (value: number) => { now = value; },
    setHook: (value: typeof globalThis.fetch) => { hook = value; }, setPrimary: (value: boolean) => { primary = value; } };
}
async function service(f = fixture()) {
  const load = modules["./external-service.ts"];
  expect(load, "Main must own complete snapshots and one-use review-bound confirmations").toBeTypeOf("function");
  const s = (await load()).createExternalSkillService(f.deps); cleanup.push(() => s.dispose()); return { ...f, s };
}
const stageDirectories = (f: ReturnType<typeof fixture>) => fs.existsSync(path.join(f.storage.cacheRoot, "external-skills")) ? fs.readdirSync(path.join(f.storage.cacheRoot, "external-skills")) : [];

it.each(["openai", "anthropic"] as const)("supported %s manifest text subset reaches exact review and remains disabled after commit", async sourceId => {
  const f = fixture(sourceId), root = sourceId === "openai" ? "plugins/synthetic/" : "";
  const path = root + (sourceId === "openai" ? "plugin.json" : ".claude-plugin/plugin.json");
  const bytes = Buffer.from(JSON.stringify({ name: "synthetic", license: "MIT", version: "bundle-9", ...(sourceId === "openai" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" } : {}) }));
  f.blobs.set(gitHash(bytes), bytes); f.tree.push({ path, type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length });
  const current = await service(f), ready = value(await current.s.prepare(owner, sourceId, f.id));
  expect(ready.skill.compatibilityFormat).toBe(sourceId === "openai" ? "openai-portable" : "claude");
  expect(value(await current.s.commit(owner, ready.token)).enabled).toBe(false);
  const saved = new ExternalSkillStateStore(f.storage).read(f.id)!;
  expect(saved.skill).not.toHaveProperty("compatibilityFormat"); expect(saved.skill).not.toHaveProperty("dependencyIssues"); expect(saved.enabled).toBe(false);
});

it("MCP declaration cannot reuse a skill's exact text approval or create an import stage", async () => {
  const f = fixture(), bytes = Buffer.from(JSON.stringify({ mcpServers: { unsafe: { command: "DO_NOT_EXECUTE" } } }));
  f.blobs.set(gitHash(bytes), bytes); f.tree.push({ path: "plugins/synthetic/.mcp.json", type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length });
  const current = await service(f); expect(await current.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" });
  expect(value(await current.s.detail(owner, "openai", f.id)).dependencyIssues).toContainEqual({ kind: "component", path: "plugins/synthetic/.mcp.json", component: "mcp" });
  expect(stageDirectories(f)).toEqual([]);
});

it.each(["nested-overlay", "strict-conflict", "shadowed-license"])("%s declaration cannot stage an exactly reviewed text payload", async kind => {
  const sourceId = kind === "nested-overlay" ? "openai" : "anthropic", f = fixture(sourceId);
  const metadata = kind === "nested-overlay"
    ? { "plugins/synthetic/plugin.json": { name: "synthetic", license: "MIT" },
      "plugins/synthetic/.codex-plugin/plugin.json": { name: "synthetic", skills: "./skills", extensions: { "com.openai": { hooks: "./lifecycle.json" } } } }
    : { ".claude-plugin/plugin.json": { name: "synthetic", license: kind === "shadowed-license" ? "Proprietary" : "MIT" },
      ...(kind === "strict-conflict" ? { ".claude-plugin/marketplace.json": { plugins: [{ name: "synthetic", source: "./", strict: false, skills: ["./skills/synthetic-text"], license: "MIT" }] } } : {}) };
  for (const [path, value] of Object.entries(metadata)) {
    const bytes = Buffer.from(JSON.stringify(value)); f.blobs.set(gitHash(bytes), bytes);
    const entry = { path, type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length }, index = f.tree.findIndex(item => item.path === path);
    if (index === -1) f.tree.push(entry); else f.tree[index] = entry;
  }
  const current = await service(f);
  expect(await current.s.prepare(owner, sourceId, f.id)).toMatchObject({ ok: false, code: kind === "shadowed-license" ? "LICENSE_BLOCKED" : "DEPENDENCY_BLOCKED" });
  expect(stageDirectories(f)).toEqual([]);
  expect(new ExternalSkillStateStore(f.storage).read(f.id)).toBeUndefined();
  expect(fs.readdirSync(f.productionSentinelRoot)).toEqual([]);
});

it("unsupported executable mode is preserved as concrete evidence after the failed full review", async () => {
  const f = fixture(); f.tree.find(entry => entry.path === f.root + "/SKILL.md")!.mode = "100755";
  const current = await service(f); expect(await current.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" });
  expect(value(await current.s.detail(owner, "openai", f.id)).dependencyIssues).toContainEqual({ kind: "file-mode", path: f.root + "/SKILL.md" });
  expect(stageDirectories(f)).toEqual([]);
});

it("Claude canonical manifest version reaches the disabled committed record", async () => {
  const f = fixture("anthropic"), bytes = Buffer.from(JSON.stringify({ name: "synthetic", version: "manifest-3", license: "MIT" }));
  f.blobs.set(gitHash(bytes), bytes); f.tree.push({ path: ".claude-plugin/plugin.json", type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length });
  const current = await service(f), ready = value(await current.s.prepare(owner, "anthropic", f.id));
  expect(ready.skill.bundle.version).toBe("manifest-3");
  expect(value(await current.s.commit(owner, ready.token)).enabled).toBe(false);
  expect(new ExternalSkillStateStore(f.storage).read(f.id)?.skill.bundle.version).toBe("manifest-3");
});

it.each(["plugin.json", ".mcp.json"])("unsupported %s metadata mode returns safe detail without stage or local paths", async name => {
  const f = fixture(), publicPath = "plugins/synthetic/" + name, bytes = Buffer.from(JSON.stringify({ name: "synthetic", private: "C:\\private-local-data\\never-read.json" }));
  f.blobs.set(gitHash(bytes), bytes); f.tree.push({ path: publicPath, type: "blob", mode: "100755", sha: gitHash(bytes), size: bytes.length });
  const current = await service(f);
  expect(await current.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" });
  const detail = value(await current.s.detail(owner, "openai", f.id));
  expect(detail).toMatchObject({ declaration: "blocked", review: "blocked", dependencyIssues: [{ kind: "file-mode", path: publicPath }] });
  for (const localPath of [f.storage.dataRoot, f.storage.stateRoot, f.storage.cacheRoot, "private-local-data"]) expect(JSON.stringify(detail)).not.toContain(localPath);
  expect(f.calls.some(url => url.endsWith(gitHash(bytes)))).toBe(false);
  expect(stageDirectories(f)).toEqual([]); expect(new ExternalSkillStateStore(f.storage).read(f.id)).toBeUndefined();
});


it("source_snapshot reuses incomplete preview, then complete prepared audit without mutable DTO authority", async () => {
  const f = await service(); const first = value(await f.s.list(owner, "openai")); const count = f.calls.length;
  expect(first[0].files).toEqual([]); value(await f.s.list(owner, "openai")); expect(f.calls).toHaveLength(count);
  const preview = value(await f.s.detail(owner, "openai", f.id)); expect(preview.review).toBe("unreviewed"); expect(preview.files).toEqual([]);
  const previewCount = f.calls.length; value(await f.s.detail(owner, "openai", f.id)); expect(f.calls).toHaveLength(previewCount);
  const ready = value(await f.s.prepare(owner, "openai", f.id)); expect(ready.contentSha256).toBe(f.review.contentSha256); expect(ready.skill.files).toEqual(f.files);
  const completeCount = f.calls.length, detail = value(await f.s.detail(owner, "openai", f.id));
  expect(detail).toMatchObject({ review: "unreviewed", files: [], licenses: [], preview: { complete: false, files: 3 } });
  ready.skill.files[0].sha256 = "0".repeat(64); ready.skill.licenses[0].covers.length = 0;
  const complete = value(await f.s.list(owner, "openai"))[0];
  expect(complete.files).toEqual(f.files); expect(complete.licenses).toEqual(f.review.licenses);
  expect(value(await f.s.detail(owner, "openai", f.id)).files).toEqual([]); expect(f.calls).toHaveLength(completeCount);
});
it.each(["openai", "anthropic"] as const)("prepare_snapshot composes real %s discovery, exact review and opaque staging before disabled commit", async sourceId => {
  const f = await service(fixture(sourceId)); let rescans = 0;
  f.deps.rescan = () => { rescans++; expect(new ExternalSkillStateStore(f.storage).read(f.id)?.status).toBe("committed"); return 1; };
  const ready = value(await f.s.prepare(owner, sourceId, f.id)); expect(ready.expiresAt).toBe(601000);
  expect(ready.skill.review).toBe("approved"); expect(ready.skill.version).toBeUndefined(); expect(ready.skill.bundle.version).toBe("bundle-9");
  const [transaction] = stageDirectories(f); const staged = path.join(f.storage.cacheRoot, "external-skills", transaction, "payload", f.id);
  for (const [file, bytes] of f.payload) expect(fs.readFileSync(path.join(staged, file.slice(f.root.length + 1)))).toEqual(bytes);
  const committed = value(await f.s.commit(owner, ready.token)); expect(committed).toEqual({ id: f.id, enabled: false, contentSha256: ready.contentSha256 });
  const state = new ExternalSkillStateStore(f.storage); expect(state.read(f.id)?.enabled).toBe(false);
  for (const [file, bytes] of f.payload) expect(fs.readFileSync(path.join(f.storage.dataRoot, "skills", f.id, "content", file.slice(f.root.length + 1)))).toEqual(bytes);
  expect(stageDirectories(f)).toEqual([]); expect(rescans).toBe(1); expect(fs.readdirSync(f.productionSentinelRoot)).toEqual([]);
});
it.each([0, 1])("F1: successful rescan count %i finalizes the real commit while preserving disabled state and exact content", async count => {
  const f = await service(), state = new ExternalSkillStateStore(f.storage, f.deps.host);
  let rescans = 0;
  f.deps.rescan = () => { rescans++; expect(state.read(f.id)).toMatchObject({ status: "committed", enabled: false }); return count; };
  const ready = value(await f.s.prepare(owner, "openai", f.id));
  expect(value(await f.s.commit(owner, ready.token))).toEqual({ id: f.id, enabled: false, contentSha256: ready.contentSha256 });
  const record = state.read(f.id)!, stateFile = path.join(f.storage.stateRoot, "external-skills", f.id + ".json"), stateBytes = fs.readFileSync(stateFile);
  const installed = path.join(f.storage.dataRoot, "skills", f.id, "content");
  const mutations = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "unlinkSync"), vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "rmdirSync")];
  expect(() => install.rollbackExternalSkill({ storage: f.storage, record, state })).toThrow("ROLLBACK_FAILED");
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  expect(fs.readFileSync(stateFile)).toEqual(stateBytes); expect(state.read(f.id)).toMatchObject({ status: "committed", enabled: false });
  for (const [file, bytes] of f.payload) expect(fs.readFileSync(path.join(installed, file.slice(f.root.length + 1)))).toEqual(bytes);
  expect(stageDirectories(f)).toEqual([]); expect(rescans).toBe(1); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" });
});
it("source_invalid is rejected before any request", async () => { const f = await service(); expect(await f.s.list(owner, "unknown" as ExternalSkillSourceId)).toMatchObject({ ok: false, code: "SOURCE_INVALID" }); expect(f.calls).toEqual([]); });
it("candidate_unknown is rejected without accepting renderer paths", async () => { const f = await service(); expect(await f.s.prepare(owner, "openai", "../outside")).toMatchObject({ ok: false, code: "CATALOG_INVALID" }); expect(stageDirectories(f)).toEqual([]); });
it("review_required never stages or issues a credential with an empty trusted registry", async () => { const raw = fixture(); raw.deps.reviews = []; const f = await service(raw); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "REVIEW_REQUIRED" }); expect(stageDirectories(f)).toEqual([]); });
it("whole_inventory downloads and blocks an unsupported script rather than dropping it", async () => { const f = await service(fixture("openai", { "scripts/run.py": "Synthetic text; never execute.\n" })); expect(value(await f.s.detail(owner, "openai", f.id)).review).toBe("unreviewed"); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "DEPENDENCY_BLOCKED" }); const detail = value(await f.s.detail(owner, "openai", f.id)); expect(detail.files).toEqual([]); expect(detail.preview?.files).toBe(4); expect(value(await f.s.list(owner, "openai"))[0].files).toHaveLength(4); expect(detail.blockers).toContain("DEPENDENCY_BLOCKED"); expect(f.calls.some(url => url.endsWith(gitHash(f.payload.get(f.root + "/scripts/run.py")!)))).toBe(true); expect(stageDirectories(f)).toEqual([]); });
it("ancestor_license is blocked instead of importing evidence outside the Skill prefix", async () => { const raw = fixture(); raw.review.licenses[0].path = "plugins/synthetic/LICENSE"; const f = await service(raw); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "LICENSE_BLOCKED" }); expect(stageDirectories(f)).toEqual([]); });
it("actual_skill_version is read from data-only frontmatter rather than the bundle", async () => { const f = await service(fixture("openai", { "SKILL.md": "---\nname: actual-name\ndescription: Actual description.\nversion: skill-2\n---\nSummarize supplied text.\n" })); const detail = value(await f.s.detail(owner, "openai", f.id)); expect(detail).toMatchObject({ upstreamName: "actual-name", description: "Actual description.", version: "skill-2" }); });
it.each(["webContentsId", "frameProcessId", "frameRoutingId", "generation"] as const)("confirmation_binding rejects different %s without consuming the valid owner's credential", async key => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); expect(await f.s.commit({ ...owner, [key]: owner[key] + 1 }, ready.token)).toMatchObject({ ok: false, code: "TOKEN_INVALID" }); value(await f.s.commit(owner, ready.token)); });
it.each([599999, 600000, 600001])("confirmation_expiry at +%ims uses the fixed completion deadline", async elapsed => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); f.setNow(1000 + elapsed); value(await f.s.detail(owner, "openai", f.id)); const result = await f.s.commit(owner, ready.token); if (elapsed < 600000) value(result); else { expect(result).toMatchObject({ ok: false, code: "TOKEN_EXPIRED" }); expect(stageDirectories(f)).toEqual([]); } });
it("global_transaction repeated prepare and another owner are BUSY and never renew expiry", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); f.setNow(500000); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "BUSY" }); expect(await f.s.prepare({ ...owner, webContentsId: 9 }, "openai", f.id)).toMatchObject({ code: "BUSY" }); f.setNow(ready.expiresAt); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_EXPIRED" }); });
it("repeat_commit consumes the credential before publication and permits one rescan", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); let scans = 0; f.deps.rescan = () => ++scans; const [a, b] = await Promise.all([f.s.commit(owner, ready.token), f.s.commit(owner, ready.token)]); value(a); expect(b).toMatchObject({ code: "TOKEN_INVALID" }); expect(scans).toBe(1); });
it("explicit_refresh invalidates approval even at the same pinned commit while safely reusing immutable blobs", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); const blobCalls = f.calls.filter(url => url.includes("/git/blobs/")).length; value(await f.s.list(owner, "openai", true)); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" }); expect(stageDirectories(f)).toEqual([]); expect(f.calls.filter(url => url.includes("/git/blobs/")).length).toBe(blobCalls); });
it("old_list cannot publish a new authority after refresh", async () => { const f = await service(); let release!: (response: Response) => void, held = false;
  f.setHook(async (input, init) => { if (!held && String(input) === "https://api.github.com/repos/openai/plugins") { held = true; return new Promise<Response>(resolve => { release = resolve; }); } return f.route(input, init); });
  const old = f.s.list(owner, "openai"); await until(() => held); const fresh = value(await f.s.list(owner, "openai", true)); release(Response.json({ default_branch: "obsolete" })); expect(await old).toMatchObject({ code: "STALE_SNAPSHOT" }); expect(value(await f.s.list(owner, "openai"))).toEqual(fresh);
});
it("cancel_before_token aborts all preparation downloads and leaves formal/sentinel data untouched", async () => { const f = await service(); let waiting = false; const bodySha = gitHash(f.payload.get(f.root + "/SKILL.md")!);
  f.setHook(async (input, init) => { if (String(input).endsWith(bodySha)) { waiting = true; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("private upstream details")), { once: true })); } return f.route(input, init); });
  const pending = f.s.prepare(owner, "openai", f.id); await until(() => waiting); expect(value(await f.s.cancel(owner))).toEqual({ status: "cancelled" }); expect(await pending).toMatchObject({ code: "CANCELLED" }); expect(stageDirectories(f)).toEqual([]); expect(fs.existsSync(path.join(f.storage.dataRoot, "skills", f.id))).toBe(false); expect(fs.readdirSync(f.productionSentinelRoot)).toEqual([]);
});
it("ready_cancel uses the original opaque stage handle and invalidates its token", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); expect(value(await f.s.cancel({ ...owner, webContentsId: 8 }))).toEqual({ status: "idle" }); expect(stageDirectories(f)).toHaveLength(1); expect(value(await f.s.cancel(owner))).toEqual({ status: "cancelled" }); expect(stageDirectories(f)).toEqual([]); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" }); });
it("invalidate prevents a pending generation from surviving into the next one", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); f.s.invalidate(owner); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" }); value(await f.s.list({ ...owner, generation: 1 }, "openai")); expect(await f.s.list(owner, "openai")).toMatchObject({ code: "STALE_SNAPSHOT" }); expect(stageDirectories(f)).toEqual([]); });
it("primary_capability is required before preparation or cache writes", async () => { const f = await service(); f.setPrimary(false); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "STATE_INVALID" }); expect(f.calls).toEqual([]); expect(stageDirectories(f)).toEqual([]); });
it("rate_limit is retryable, has no automatic loop and never revives a refreshed stale approval", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); f.setHook(async () => Response.json({ message: "private" }, { status: 429 })); const before = f.calls.length; expect(await f.s.list(owner, "openai", true)).toMatchObject({ code: "RATE_LIMITED", retryable: true }); expect(f.calls).toHaveLength(before + 1); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" }); });
it("file_count is bounded from the complete tree before selected bytes download", async () => { const raw = fixture(); for (let i = 0; i < 198; i++) raw.tree.push({ path: raw.root + `/references/${i}.txt`, type: "blob", mode: "100644", sha: "c".repeat(40), size: 1 }); const f = await service(raw); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "LIMIT_EXCEEDED" }); expect(f.calls.some(url => url.endsWith(gitHash(f.payload.get(f.root + "/SKILL.md")!)))).toBe(false); });
it("total_bytes is bounded from complete pinned inventory before selected bytes download", async () => { const raw = fixture(); for (let i = 0; i < 11; i++) raw.tree.push({ path: raw.root + `/references/${i}.txt`, type: "blob", mode: "100644", sha: "c".repeat(40), size: EXTERNAL_LIMITS.fileBytes }); const f = await service(raw); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "LIMIT_EXCEEDED" }); expect(stageDirectories(f)).toEqual([]); });
it("tree_size must match the verified blob's actual decoded bytes", async () => { const raw = fixture(); raw.tree.find(file => file.path === raw.root + "/SKILL.md")!.size++; const f = await service(raw); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "BLOB_MISMATCH" }); expect(stageDirectories(f)).toEqual([]); });
it("request_timeout remains distinct and aborts an ignoring fetch", async () => { vi.useFakeTimers(); const f = await service(); f.setHook(async () => new Promise<Response>(() => {})); const pending = f.s.prepare(owner, "openai", f.id); await vi.advanceTimersByTimeAsync(15000); expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true }); expect(f.signals.every(signal => signal.aborted)).toBe(true); });
it("prepare_timeout bounds discovery plus download even when every request is within 15s", async () => { vi.useFakeTimers(); const extra = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`references/${i}.txt`, `Synthetic text ${i}.\n`])); const f = await service(fixture("openai", extra)); f.setHook(async (input, init) => { await new Promise(resolve => setTimeout(resolve, 14000)); return f.route(input, init); }); const pending = f.s.prepare(owner, "openai", f.id); await vi.advanceTimersByTimeAsync(120000); expect(await pending).toMatchObject({ code: "PREPARE_TIMEOUT", retryable: true }); expect(stageDirectories(f)).toEqual([]); });
it("download_concurrency is globally bounded across a full preparation and the other source preview", async () => {
  const extra = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`references/${i}.txt`, `Synthetic text ${i}.\n`]));
  const raw = fixture("openai", extra), other = fixture("anthropic", extra); raw.deps.reviews = [raw.review, other.review]; const f = await service(raw);
  let active = 0, peak = 0;
  f.setHook(async (input, init) => { active++; peak = Math.max(peak, active); try { await new Promise(resolve => setTimeout(resolve, 2)); return await (String(input).includes("/anthropics/") ? other.route : f.route)(input, init); } finally { active--; } });
  value(await f.s.list(owner, "openai")); value(await f.s.list(owner, "anthropic")); peak = 0;
  const results = await Promise.all([f.s.prepare(owner, "openai", f.id), f.s.detail(owner, "anthropic", other.id)]); results.forEach(value);
  expect(peak).toBeLessThanOrEqual(4); expect(peak).toBe(4);
});
it("storage_failure consumes the token and cleans only its owned stage without rescan", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); const rename = fs.renameSync; vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (path.basename(String(to)) === "content") throw Error("private filesystem path"); return rename(from, to); }); let scans = 0; f.deps.rescan = () => ++scans; expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STORAGE_FAILED" }); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" }); expect(scans).toBe(0); expect(stageDirectories(f)).toEqual([]); expect(fs.existsSync(path.join(f.storage.dataRoot, "skills", f.id))).toBe(false); });
it("rescan_failure rolls back precisely the new disabled transaction", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); f.deps.rescan = () => { throw Error("private"); }; expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STORAGE_FAILED" }); expect(new ExternalSkillStateStore(f.storage).read(f.id)).toBeUndefined(); expect(fs.existsSync(path.join(f.storage.dataRoot, "skills", f.id))).toBe(false); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" }); });
it.each(["throw", "negative", "fractional", "NaN"])("F1: %s rescan retains real rollback authority and never finalizes success", async kind => {
  const f = await service(), ready = value(await f.s.prepare(owner, "openai", f.id)), realRollback = install.rollbackExternalSkill;
  expect(install.finalizeExternalSkillCommit).toBeTypeOf("function");
  const finalize = vi.spyOn(install, "finalizeExternalSkillCommit");
  const rollback = vi.spyOn(install, "rollbackExternalSkill").mockImplementation(input => { expect(finalize).not.toHaveBeenCalled(); realRollback(input); });
  let rescans = 0;
  f.deps.rescan = () => { rescans++; if (kind === "throw") throw Error("private"); return kind === "negative" ? -1 : kind === "fractional" ? 0.5 : NaN; };
  expect(await f.s.commit(owner, ready.token)).toMatchObject({ ok: false, code: "STORAGE_FAILED" });
  expect(rescans).toBe(1); expect(rollback).toHaveBeenCalledOnce(); expect(finalize).not.toHaveBeenCalled();
  expect(new ExternalSkillStateStore(f.storage).read(f.id)).toBeUndefined(); expect(fs.existsSync(path.join(f.storage.stateRoot, "external-skills", f.id + ".json"))).toBe(false);
  expect(fs.existsSync(path.join(f.storage.dataRoot, "skills", f.id))).toBe(false); expect(stageDirectories(f)).toEqual([]);
  expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" });
});
it("target_exists retains the user directory and consumes the credential", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); const target = path.join(f.storage.dataRoot, "skills", f.id); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, "private.txt"), "user bytes"); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TARGET_EXISTS" }); expect(fs.readFileSync(path.join(target, "private.txt"), "utf8")).toBe("user bytes"); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" }); expect(stageDirectories(f)).toEqual([]); });
it("tampered_stage rejects commit and preserves unknown bytes instead of arbitrary cleanup", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); const transaction = stageDirectories(f)[0]; const foreign = path.join(f.storage.cacheRoot, "external-skills", transaction, "payload", f.id, "unknown.txt"); fs.writeFileSync(foreign, "unknown"); const result = await f.s.commit(owner, ready.token); expect(result).toMatchObject({ ok: false, code: "ROLLBACK_FAILED" }); expect(fs.readFileSync(foreign, "utf8")).toBe("unknown"); expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "TOKEN_INVALID" }); await expect(f.s.dispose()).rejects.toMatchObject({ code: "ROLLBACK_FAILED" }); cleanup.pop(); });
it("cancel_during_commit returns committing and dispose awaits the actual terminal publication", async () => { const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); const real = install.commitExternalSkill; let release!: () => void, entered = false;
  vi.spyOn(install, "commitExternalSkill").mockImplementation(async input => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return real(input); });
  const committing = f.s.commit(owner, ready.token); await until(() => entered); expect(value(await f.s.cancel(owner))).toEqual({ status: "committing" }); let finished = false; const disposal = f.s.dispose().then(() => { finished = true; }); await new Promise(resolve => setImmediate(resolve)); expect(finished).toBe(false); release(); value(await committing); await disposal; expect(new ExternalSkillStateStore(f.storage).read(f.id)?.enabled).toBe(false); expect(await f.s.list(owner, "openai")).toMatchObject({ code: "FORBIDDEN" });
});
it("dispose aborts unfinished preparation and waits for cancellation cleanup", async () => { const f = await service(); let entered = false; f.setHook(async (_input, init) => { entered = true; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true })); }); const pending = f.s.prepare(owner, "openai", f.id); await until(() => entered); await f.s.dispose(); expect(await pending).toMatchObject({ code: "CANCELLED" }); expect(stageDirectories(f)).toEqual([]); });

function additionalCandidate(f: ReturnType<typeof fixture>, name: string, extra: Record<string, string | Buffer>) {
  const prefix = "plugins/synthetic/skills/" + name;
  const payload = new Map(Object.entries({ ...createExternalFixture().expectedFiles, ...extra }).map(([relative, bytes]) => [prefix + "/" + relative, Buffer.from(bytes)]));
  const files = [...payload].map(([path, bytes]) => ({ path, blobSha1: gitHash(bytes), sha256: hash(bytes), bytes: bytes.length }));
  for (const [path, bytes] of payload) { f.tree.push({ path, type: "blob", mode: "100644", sha: gitHash(bytes), size: bytes.length }); f.blobs.set(gitHash(bytes), bytes); }
  f.deps.reviews = [...f.deps.reviews, { ...f.review, path: prefix, contentSha256: digestExternalFiles(files), licenses: [{ path: prefix + "/LICENSE", sha256: hash(payload.get(prefix + "/LICENSE")!), spdx: "MIT", covers: files.map(file => file.path) }] }];
  return externalSkillId("openai", "openai/plugins", prefix);
}
it("cache_byte_budget evicts immutable blobs beyond 10MiB and retains only one complete detail per source", async () => {
  const big = (label: string) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`references/${i}.txt`, Buffer.alloc(EXTERNAL_LIMITS.fileBytes, label + i)]));
  const raw = fixture("openai", big("first")); const secondId = additionalCandidate(raw, "second", big("second")); const f = await service(raw);
  value(await f.s.prepare(owner, "openai", f.id)); value(await f.s.cancel(owner)); value(await f.s.prepare(owner, "openai", secondId)); value(await f.s.cancel(owner));
  const listing = value(await f.s.list(owner, "openai")); expect(listing.find(skill => skill.id === f.id)?.files).toEqual([]); expect(listing.find(skill => skill.id === secondId)?.review).toBe("approved");
  const before = f.calls.length; value(await f.s.prepare(owner, "openai", f.id)); value(await f.s.cancel(owner)); expect(f.calls.length).toBeGreaterThan(before);
});
it("cache_entry_budget evicts beyond 200 small immutable blobs independently of the byte budget", async () => {
  const refs = (label: string) => Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`references/${i}.txt`, `Synthetic unique ${label} ${i}.\n`]));
  const raw = fixture("openai", refs("first")); const secondId = additionalCandidate(raw, "second", refs("second"));
  // Exercise full downloads and review without staging hundreds of files: this
  // cache test has no trusted approval; transaction ownership is covered above.
  raw.deps.reviews = []; const f = await service(raw);
  const audit = async (id: string) => {
    expect(await f.s.prepare(owner, "openai", id)).toMatchObject({ ok: false, code: "REVIEW_REQUIRED" });
    const complete = value(await f.s.list(owner, "openai")).find(skill => skill.id === id)!;
    expect(complete.files).toHaveLength(113); expect(complete.preview).toBeUndefined();
    const beforePreview = f.calls.length, preview = value(await f.s.detail(owner, "openai", id));
    expect(preview.files).toEqual([]); expect(preview.preview?.files).toBe(113); expect(f.calls).toHaveLength(beforePreview);
    expect(stageDirectories(f)).toEqual([]);
  };
  await audit(f.id); await audit(secondId); const before = f.calls.length;
  await audit(f.id); expect(f.calls.length).toBeGreaterThan(before);
});
it("refresh clears the complete detail snapshot while disposal releases prepared ownership and denies cache reuse", async () => {
  const f = await service(); value(await f.s.prepare(owner, "openai", f.id)); expect(value(await f.s.list(owner, "openai", true))[0].files).toEqual([]);
  value(await f.s.prepare(owner, "openai", f.id)); await f.s.dispose(); expect(stageDirectories(f)).toEqual([]); expect(await f.s.detail(owner, "openai", f.id)).toMatchObject({ code: "FORBIDDEN" });
  const before = f.calls.length; const fresh = await service(f); value(await fresh.s.list(owner, "openai")); expect(f.calls.length).toBeGreaterThan(before);
});
it("executable_inventory is blocked even when an executable blob has a text-compatible filename", async () => {
  const raw = fixture(); raw.tree.find(entry => entry.path === raw.root + "/SKILL.md")!.mode = "100755"; const f = await service(raw);
  expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" }); expect(stageDirectories(f)).toEqual([]);
});
it("malformed_neighbor_review cannot break the real evaluator's fail-closed review selection", async () => {
  const raw = fixture(); raw.deps.reviews = [null as unknown as ExternalSkillReview, raw.review]; const f = await service(raw);
  expect(value(await f.s.prepare(owner, "openai", f.id)).skill.review).toBe("approved");
});
it("url_catalog_candidate remains informational-only without preparing its synthetic path", async () => {
  const raw = fixture(), catalogPath = EXTERNAL_SOURCES.openai.catalogPath;
  const bytes = Buffer.from(JSON.stringify({ plugins: [{ name: "remote-entry", source: { source: "url", url: "https://example.invalid/repository" } }] }));
  raw.blobs.set(gitHash(bytes), bytes); Object.assign(raw.tree.find(entry => entry.path === catalogPath)!, { sha: gitHash(bytes), size: bytes.length });
  const f = await service(raw); const listing = value(await f.s.list(owner, "openai")); const before = f.calls.length;
  expect(listing[0].review).toBe("blocked"); expect(await f.s.prepare(owner, "openai", listing[0].id)).toMatchObject({ code: "DEPENDENCY_BLOCKED" });
  expect(f.calls).toHaveLength(before); expect(f.calls.every(url => url.startsWith("https://api.github.com/repos/openai/plugins"))).toBe(true); expect(stageDirectories(f)).toEqual([]);
});
it("expired_preparation can be replaced without extending or reviving the old credential", async () => { const f = await service(); const first = value(await f.s.prepare(owner, "openai", f.id)); f.setNow(first.expiresAt); const second = value(await f.s.prepare(owner, "openai", f.id)); expect(second.expiresAt).toBe(first.expiresAt + 600000); expect(second.token).not.toBe(first.token); expect(await f.s.commit(owner, first.token)).toMatchObject({ code: "TOKEN_EXPIRED" }); value(await f.s.commit(owner, second.token)); });
it("invalid_completion_clock cannot produce a non-expiring approval", async () => { const f = await service(); f.setNow(NaN); expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "STATE_INVALID" }); expect(stageDirectories(f)).toEqual([]); });

it("failed_owned_cleanup retains the exact handle so disposal retries instead of orphaning a recoverable stage", async () => {
  const f = await service(); value(await f.s.prepare(owner, "openai", f.id)); const real = install.discardExternalStage;
  vi.spyOn(install, "discardExternalStage").mockImplementationOnce(() => { throw new ExternalStorageError("ROLLBACK_FAILED"); }).mockImplementation(real);
  expect(await f.s.cancel(owner)).toMatchObject({ ok: false, code: "ROLLBACK_FAILED" }); expect(stageDirectories(f)).toHaveLength(1);
  await f.s.dispose(); expect(stageDirectories(f)).toEqual([]);
});
it("another_trusted_owner_refresh invalidates the source approval without broadening cancellation ownership", async () => {
  const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id)); value(await f.s.list({ ...owner, webContentsId: 6 }, "openai", true));
  expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" }); expect(stageDirectories(f)).toEqual([]);
});

it.each([119999, 120000, 120001])("prepare_deadline rejects synchronous owned staging finishing at +%ims without timer delivery", async elapsed => {
  vi.useFakeTimers();
  const f = await service(), realStage = install.stageExternalSkill;
  vi.spyOn(install, "stageExternalSkill").mockImplementation((storage, record, payload) => {
    const handle = realStage(storage, record, payload); // Real complete owned filesystem staging.
    f.setNow(1000 + elapsed); // No timer advance: synchronous work can cross the absolute deadline.
    return handle;
  });
  const prepared = await f.s.prepare(owner, "openai", f.id);
  expect(fs.existsSync(path.join(f.storage.dataRoot, "skills", f.id))).toBe(false);
  expect(new ExternalSkillStateStore(f.storage).read(f.id)).toBeUndefined();
  if (elapsed < 120000) {
    const ready = value(prepared); expect(ready.expiresAt).toBe(1000 + elapsed + 600000);
    expect(stageDirectories(f)).toHaveLength(1); value(await f.s.cancel(owner));
  } else {
    expect(prepared).toMatchObject({ ok: false, code: "PREPARE_TIMEOUT", retryable: true });
    expect(prepared).not.toHaveProperty("value"); expect(stageDirectories(f)).toEqual([]);
  }
});
it("prepare_deadline preserves owned cleanup failure precedence over the elapsed timeout", async () => {
  vi.useFakeTimers();
  const f = await service(), realStage = install.stageExternalSkill, realDiscard = install.discardExternalStage;
  vi.spyOn(install, "stageExternalSkill").mockImplementation((storage, record, payload) => {
    const handle = realStage(storage, record, payload); f.setNow(121001); return handle;
  });
  vi.spyOn(install, "discardExternalStage").mockImplementationOnce(() => { throw new ExternalStorageError("ROLLBACK_FAILED"); }).mockImplementation(realDiscard);
  expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "ROLLBACK_FAILED" });
  expect(stageDirectories(f)).toHaveLength(1); expect(fs.existsSync(path.join(f.storage.dataRoot, "skills", f.id))).toBe(false);
  await f.s.dispose(); expect(stageDirectories(f)).toEqual([]);
});

it.each([429, 403])("shared_rate_cooldown %i blocks immediate refresh, source switching and a new frame without upstream calls", async status => {
  const f = await service(); f.setHook(async () => new Response(null, { status, headers: { "retry-after": "120", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "3600" } }));
  expect(await f.s.list(owner, "openai")).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  const before = f.calls.length;
  for (const [actor, sourceId, refresh] of [[owner, "openai", true], [owner, "anthropic", false], [{ ...owner, webContentsId: 99 }, "anthropic", true]] as const) {
    expect(await f.s.list(actor, sourceId, refresh)).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  }
  expect(f.calls).toHaveLength(before);
  f.setNow(120999); expect(await f.s.list(owner, "openai", true)).toMatchObject({ code: "RATE_LIMITED" }); expect(f.calls).toHaveLength(before);
  f.setNow(121000); f.setHook(f.route); expect(value(await f.s.list(owner, "openai"))).toHaveLength(1); expect(f.calls.length).toBeGreaterThan(before);
});
it("refresh during shared cooldown still invalidates an older prepared token", async () => {
  const f = await service(), ready = value(await f.s.prepare(owner, "openai", f.id));
  f.setHook(async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "121" } }));
  expect(await f.s.list(owner, "anthropic")).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  const before = f.calls.length; expect(await f.s.list(owner, "openai", true)).toMatchObject({ code: "RATE_LIMITED" }); expect(f.calls).toHaveLength(before);
  expect(await f.s.commit(owner, ready.token)).toMatchObject({ code: "STALE_SNAPSHOT" });
});

it("lazy_declaration catalog costs five requests and only selected detail reads its manifest", async () => {
  const f = await service(); const listed = value(await f.s.list(owner, "openai"));
  expect(f.calls).toHaveLength(5); expect(listed[0]).toMatchObject({ declaration: "pending", review: "unreviewed", bundle: { name: "synthetic" } });
  expect(listed[0].bundle.license).toBeUndefined(); expect(listed[0].bundle.version).toBeUndefined();
  const detail = value(await f.s.detail(owner, "openai", f.id)); expect(detail).toMatchObject({ declaration: "verified", review: "unreviewed", files: [], licenses: [], preview: { complete: false }, bundle: { license: "MIT", version: "bundle-9" } }); expect(f.calls).toHaveLength(7);
  const calls = f.calls.length; value(await f.s.detail(owner, "openai", f.id)); expect(f.calls).toHaveLength(calls);
});
it("lazy_declaration direct prepare cannot bypass accurate manifest membership", async () => {
  const f = fixture(), manifest = Buffer.from(JSON.stringify({ name: "synthetic", skills: "./undeclared", license: "MIT" }));
  const key = "plugins/synthetic/.codex-plugin/plugin.json", entry = f.tree.find(item => item.path === key)!;
  entry.sha = gitHash(manifest); entry.size = manifest.length; f.blobs.set(entry.sha, manifest);
  const s = await service(f); expect(value(await s.s.list(owner, "openai"))[0].declaration).toBe("pending");
  expect(await s.s.prepare(owner, "openai", f.id)).toMatchObject({ ok: false, code: "DEPENDENCY_BLOCKED" }); expect(stageDirectories(s)).toEqual([]);
  const detail = value(await s.s.detail(owner, "openai", f.id)); expect(detail).toMatchObject({ declaration: "blocked", review: "blocked" });
});

it("readonly declaration is verified for preparation but never broadens the persisted state schema", async () => {
  const f = await service(), ready = value(await f.s.prepare(owner, "openai", f.id));
  expect(ready.skill.declaration).toBe("verified");
  value(await f.s.commit(owner, ready.token));
  const persisted = JSON.parse(fs.readFileSync(path.join(f.storage.stateRoot, "external-skills", f.id + ".json"), "utf8"));
  expect(persisted.skill).not.toHaveProperty("declaration"); expect(persisted.skill).not.toHaveProperty("preview");
  expect(new ExternalSkillStateStore(f.storage).read(f.id)?.status).toBe("committed");
});

it("queued requests across sources remain blocked when a content request exhausts the shared budget", async () => {
  const f = await service(fixture("openai", Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["references/part-" + i + ".txt", "Synthetic reference."]))));
  value(await f.s.list(owner, "openai"));
  const bodyHashes = new Set(f.files.map(file => file.blobSha1)), gates: Array<{ url: string; resolve: (response: Response) => void }> = [];
  f.setHook(async input => { const url = String(input); if (!bodyHashes.has(url.split("/").at(-1)!)) return f.route(input); return new Promise<Response>(resolve => gates.push({ url, resolve })); });
  const detail = f.s.prepare(owner, "openai", f.id); await until(() => gates.length === 4);
  const queued = f.s.list({ ...owner, webContentsId: 55 }, "anthropic"); await new Promise(resolve => setImmediate(resolve));
  const before = f.calls.length; gates[0].resolve(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
  for (const gate of gates.slice(1)) gate.resolve(await f.route(gate.url));
  const [a, b] = await Promise.all([detail, queued]); expect(a).toMatchObject({ code: "RATE_LIMITED" }); expect(b).toMatchObject({ code: "RATE_LIMITED" }); expect(f.calls).toHaveLength(before);
});
it("selected declaration and detail share one pending manifest read", async () => {
  const f = await service(); value(await f.s.list(owner, "openai"));
  const manifestSha = f.tree.find(entry => entry.path.endsWith("/.codex-plugin/plugin.json"))!.sha;
  let resolve!: (response: Response) => void, reads = 0;
  f.setHook(async input => { if (String(input).endsWith("/git/blobs/" + manifestSha)) { reads++; return new Promise<Response>(done => { resolve = done; }); } return f.route(input); });
  const first = f.s.detail(owner, "openai", f.id), second = f.s.detail({ ...owner, webContentsId: 99 }, "openai", f.id);
  await until(() => reads === 1); resolve(await f.route("https://api.github.com/repos/openai/plugins/git/blobs/" + manifestSha));
  expect(value(await first).declaration).toBe("verified"); expect(value(await second).declaration).toBe("verified"); expect(reads).toBe(1);
});

it("lightweight_preview reads only owning declaration and SKILL.md before full prepare audits every one of 35 files", async () => {
  const f = await service(fixture("openai", Object.fromEntries(Array.from({ length: 32 }, (_, i) => ["references/preview-" + i + ".txt", "Synthetic preview reference " + i + ".\n"]))));
  value(await f.s.list(owner, "openai")); expect(f.calls).toHaveLength(5);
  const preview = value(await f.s.detail(owner, "openai", f.id));
  expect(f.calls).toHaveLength(7);
  expect(preview).toMatchObject({ declaration: "verified", review: "unreviewed", blockers: ["REVIEW_REQUIRED"], files: [], licenses: [],
    preview: { complete: false, files: 35, bytes: f.files.reduce((n, file) => n + file.bytes, 0),
      licenseFiles: [{ path: f.root + "/LICENSE", bytes: f.payload.get(f.root + "/LICENSE")!.length, blobSha1: gitHash(f.payload.get(f.root + "/LICENSE")!) }] } });
  expect(stageDirectories(f)).toEqual([]); expect(await f.s.commit(owner, "e".repeat(64))).toMatchObject({ code: "TOKEN_INVALID" });
  const before = f.calls.length; value(await f.s.detail(owner, "openai", f.id)); expect(f.calls).toHaveLength(before);
  const ready = value(await f.s.prepare(owner, "openai", f.id));
  expect(f.calls.length - before).toBe(34); expect(ready.skill.files).toEqual(f.files);
  expect(ready.skill).not.toHaveProperty("preview"); expect(ready.skill.licenses).toEqual(f.review.licenses);
  value(await f.s.commit(owner, ready.token));
  const persisted = new ExternalSkillStateStore(f.storage).read(f.id)!;
  expect(persisted.skill).not.toHaveProperty("preview"); expect(persisted.enabled).toBe(false);
});
it("lightweight_preview never treats a known static review as a completed payload audit and isolates returned DTO mutations", async () => {
  const f = await service(); value(await f.s.list(owner, "openai"));
  const preview = value(await f.s.detail(owner, "openai", f.id));
  expect(preview.review).toBe("unreviewed"); expect(preview.files).toEqual([]); expect(preview.licenses).toEqual([]);
  const metadata = (preview as typeof preview & { preview: { licenseFiles: Array<{ path: string }> } }).preview;
  metadata.licenseFiles[0].path = "forged";
  expect(value(await f.s.detail(owner, "openai", f.id))).not.toEqual(preview); expect(stageDirectories(f)).toEqual([]);
});
it("operation_rate_diagnostics count only actual detail HTTP attempts and no requests during global cooldown", async () => {
  const raw = fixture(), diagnostics: unknown[] = []; raw.deps.diagnose = item => diagnostics.push(item);
  const f = await service(raw); value(await f.s.list(owner, "openai"));
  const body = gitHash(f.payload.get(f.root + "/SKILL.md")!);
  f.setHook(async (input, init) => String(input).endsWith(body) ? new Response(null, { status: 403, headers: { date: "Thu, 01 Jan 1970 00:10:00 GMT", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "720" } }) : f.route(input, init));
  expect(await f.s.detail(owner, "openai", f.id)).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  expect(diagnostics).toContainEqual(expect.objectContaining({ operation: "detail", requestCount: 2, stage: "blob", status: 403, remaining: 0, reset: 720000, serverTime: 600000, retryAt: 121000, deadlineSource: "reset" }));
  const count = f.calls.length; expect(await f.s.list({ ...owner, webContentsId: 99 }, "anthropic")).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  expect(f.calls).toHaveLength(count); expect(diagnostics).toContainEqual(expect.objectContaining({ operation: "list", requestCount: 0, code: "RATE_LIMITED" }));
});

it("lightweight_preview stays incomplete after full prepare and reuses the audited introduction without HTTP", async () => {
  const f = await service(); const ready = value(await f.s.prepare(owner, "openai", f.id));
  const before = f.calls.length;
  const detail = value(await f.s.detail(owner, "openai", f.id));
  expect(detail).toMatchObject({ review: "unreviewed", files: [], licenses: [], preview: { complete: false, files: 3 } });
  expect(f.calls).toHaveLength(before);
  value(await f.s.cancel(owner));
  const again = value(await f.s.prepare(owner, "openai", f.id));
  expect(again.skill.files).toEqual(f.files); expect(again.contentSha256).toBe(ready.contentSha256);
  expect(again.skill).not.toHaveProperty("preview"); expect(f.calls).toHaveLength(before);
});
it("local_cooldown diagnoses existing snapshot detail and prepare with no physical HTTP or duplicate discovery log", async () => {
  const raw = fixture(), diagnostics: Array<Record<string, unknown>> = [];
  raw.deps.diagnose = item => diagnostics.push({ ...item });
  const f = await service(raw); value(await f.s.list(owner, "openai"));
  const body = gitHash(f.payload.get(f.root + "/SKILL.md")!);
  f.setHook(async (input, init) => String(input).endsWith(body) ? new Response(null, { status: 403, headers: { date: "Thu, 01 Jan 1970 00:10:00 GMT", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "720" } }) : f.route(input, init));
  expect(await f.s.detail(owner, "openai", f.id)).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  diagnostics.length = 0; const before = f.calls.length;
  expect(await f.s.detail(owner, "openai", f.id)).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ operation: "detail", requestCount: 0, status: null, retryAt: 121000, code: "RATE_LIMITED", deadlineSource: "reset" });
  diagnostics.length = 0;
  expect(await f.s.prepare(owner, "openai", f.id)).toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  expect(diagnostics).toContainEqual(expect.objectContaining({ operation: "prepare", requestCount: 0, status: null, retryAt: 121000, code: "RATE_LIMITED" }));
  expect(f.calls).toHaveLength(before); expect(stageDirectories(f)).toEqual([]);
});

it("firefly_native installs our own Skill with exactly its reviewed Firefly metadata, which registration then uses", async () => {
  const f = fixture("firefly", { "SKILL.md": "---\nname: synthetic-text\ndescription: A synthetic Firefly Skill.\nmodes:\n  - work\neffectKind: mutation\ntools:\n  - obsidian_read_file\n---\nSummarize supplied text.\n" });
  f.review.policyVersion = "firefly-native-v1";
  f.review.native = { modes: ["work"], effectKind: "mutation", tools: ["obsidian_read_file"] };
  const current = await service(f), ready = value(await current.s.prepare(owner, "firefly", f.id));
  expect(ready.skill.native).toEqual(f.review.native);
  value(await current.s.commit(owner, ready.token));
  const store = new ExternalSkillStateStore(f.storage), saved = store.read(f.id)!;
  expect(saved.reviewPolicyVersion).toBe("firefly-native-v1");
  expect(saved.skill.native).toEqual(f.review.native);
  const { scanExternalSkills } = await import("./external-scan");
  expect(scanExternalSkills(f.storage, store).find(entry => entry.id === f.id)).toMatchObject({ modes: ["work"], effectKind: "mutation", tools: ["obsidian_read_file"] });
});

it("built_in a market Skill named like a shipped Skill is listed as built in and never staged or installed", async () => {
  const raw = fixture("anthropic"); raw.deps.builtInSkillIds = () => new Set(["synthetic-text"]);
  const f = await service(raw);
  expect(value(await f.s.list(owner, "anthropic"))[0]).toMatchObject({ id: f.id, builtIn: true });
  expect(await f.s.prepare(owner, "anthropic", f.id)).toMatchObject({ ok: false, code: "TARGET_EXISTS" });
  expect(stageDirectories(f)).toEqual([]); expect(new ExternalSkillStateStore(f.storage).read(f.id)).toBeUndefined();
});
