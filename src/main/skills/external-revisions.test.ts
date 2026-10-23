import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { ExternalPrepared, ExternalResult, ExternalSkill } from "../../shared/external-skills";
import type { ExternalOwner, ExternalSkillReview } from "./external-types";
import { createExternalSkillService } from "./external-service";
import { externalSkillId } from "./external-policy";
import { ExternalSkillStateStore } from "./external-state";
import { evaluateExternalSkill } from "./external-review";
import { createExternalFixture, isolatedStorageContext } from "./testing/external-fixtures";

const policyVersion = "firefly-instruction-only-v1";
const owner: ExternalOwner = { webContentsId: 17, frameProcessId: 18, frameRoutingId: 19, generation: 0 };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const gitSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const oldCommit = "a".repeat(40), headCommit = "c".repeat(40);
const skillPath = "plugins/synthetic/skills/synthetic-text", catalogPath = ".agents/plugins/marketplace.json";
const base = "https://api.github.com/repos/openai/plugins";
function value<T>(result: ExternalResult<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(result.code); return result.value; }

function revisionFixture(latest: "changed" | "removed" | "empty" = "changed", alterReview?: (review: ExternalSkillReview) => void) {
  const isolated = isolatedStorageContext();
  cleanup.push(() => { isolated.dispose(); fs.rmSync(isolated.productionSentinelRoot, { recursive: true, force: true }); });
  const oldPayload = new Map(Object.entries(createExternalFixture().expectedFiles).map(([relative, text]) => [skillPath + "/" + relative, Buffer.from(text)]));
  const inventory = [...oldPayload].map(([path, bytes]) => ({ path, blobSha1: gitSha(bytes), sha256: sha256(bytes), bytes: bytes.length }));
  const tuples = [...inventory].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.sha256, file.bytes]);
  const review: ExternalSkillReview = Object.assign({ sourceId: "openai" as const, commit: oldCommit, path: skillPath,
    contentSha256: sha256(JSON.stringify(tuples)), licenses: [{ path: skillPath + "/LICENSE", sha256: sha256(oldPayload.get(skillPath + "/LICENSE")!), spdx: "MIT", covers: inventory.map(file => file.path) }],
    compatibility: "instruction-only" as const, reviewedAt: "2026-10-08T00:00:00.000Z", reviewer: "synthetic-revision-test" }, { policyVersion });
  alterReview?.(review);
  const catalog = { plugins: [{ name: "synthetic", source: { source: "local", path: "./plugins/synthetic" } }] };
  const metadata = new Map([[catalogPath, Buffer.from(JSON.stringify(catalog))], ["plugins/synthetic/.codex-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "synthetic", skills: "./skills", license: "MIT" }))]]);
  const headPayload = new Map([...oldPayload].map(([name, bytes]) => [latest === "removed" ? name.replace(skillPath, "plugins/synthetic/skills/other") : name,
    name.endsWith("/SKILL.md") ? Buffer.from("---\nname: synthetic-text\ndescription: Latest text is unreviewed\n---\nSummarize the newly supplied text.\n") : bytes]));
  const oldFiles = new Map([...metadata, ...oldPayload]);
  const headFiles = latest === "empty" ? new Map([[catalogPath, Buffer.from('{"plugins":[]}')]]) : new Map([...metadata, ...headPayload]);
  const blobs = new Map([...oldFiles, ...headFiles].map(([, bytes]) => [gitSha(bytes), bytes]));
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url === base) return Response.json({ default_branch: "main" });
    if (url === base + "/commits/main") return Response.json({ sha: headCommit });
    for (const [commit, treeSha, files] of [[oldCommit, "b".repeat(40), oldFiles], [headCommit, "d".repeat(40), headFiles]] as const) {
      if (url === base + "/git/commits/" + commit) return Response.json({ sha: commit, tree: { sha: treeSha } });
      if (url === base + "/git/trees/" + treeSha + "?recursive=1") return Response.json({ sha: treeSha, truncated: false,
        tree: [...files].map(([path, bytes]) => ({ path, mode: "100644", type: "blob", sha: gitSha(bytes), size: bytes.length })) });
    }
    const bytes = blobs.get(url.slice((base + "/git/blobs/").length));
    if (url.startsWith(base + "/git/blobs/") && bytes) return Response.json({ sha: gitSha(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
    return Response.json({ message: "Unexpected synthetic route" }, { status: 404 });
  };
  const reviews = [review];
  const service = createExternalSkillService({ storage: isolated.storage, host: { runId: randomUUID(), isPrimaryProcess: () => true },
    fetch, now: () => 1000, randomToken: () => sha256(randomUUID()), reviews, rescan: () => 1 });
  cleanup.push(() => service.dispose());
  const id = externalSkillId("openai", "openai/plugins", skillPath);
  const prepare = (selection: unknown) => Reflect.apply(service.prepare, service, [owner, "openai", id, selection]) as Promise<ExternalResult<ExternalPrepared>>;
  const detail = (selection: unknown) => Reflect.apply(service.detail, service, [owner, "openai", id, selection]) as Promise<ExternalResult<ExternalSkill>>;
  const stages = () => fs.existsSync(path.join(isolated.storage.cacheRoot, "external-skills")) ? fs.readdirSync(path.join(isolated.storage.cacheRoot, "external-skills")) : [];
  return { ...isolated, service, id, review, inventory, oldPayload, calls, prepare, detail, stages };
}

it("latest discovery and reviewed approval keep distinct fixed identities after HEAD advances", async () => {
  const f = revisionFixture(), row = value(await f.service.list(owner, "openai"))[0];
  expect(row).toMatchObject({ commit: headCommit, review: "unreviewed", revisions: { latest: { commit: headCommit }, reviewed: { commit: oldCommit, contentSha256: f.review.contentSha256, policyVersion } } });
  expect(row.revisions?.installed).toBeUndefined();
  expect(await f.prepare({ kind: "latest", commit: headCommit })).toMatchObject({ ok: false, code: "REVIEW_REQUIRED" });
  expect(f.stages()).toEqual([]);
});

it("an approved revision loads its own pinned tree without resolving or approving current HEAD", async () => {
  const f = revisionFixture();
  const old = value(await f.detail({ kind: "reviewed", commit: oldCommit })); expect(old.commit).toBe(oldCommit);
  const ready = value(await f.prepare({ kind: "reviewed", commit: oldCommit }));
  expect(ready.skill.commit).toBe(oldCommit); expect(ready.contentSha256).toBe(f.review.contentSha256);
  expect(f.calls).not.toContain(base + "/commits/main");
  const committed = value(await f.service.commit(owner, ready.token)); expect(committed.enabled).toBe(false);
  const record = new ExternalSkillStateStore(f.storage).read(f.id)!;
  expect(record.skill).not.toHaveProperty("revisions"); expect(record.skill).not.toHaveProperty("selection");
  expect(record).toHaveProperty("reviewPolicyVersion", policyVersion);
});

it.each(["removed", "empty"] as const)("reviewed entry remains reachable when the latest catalog is %s", async latest => {
  const f = revisionFixture(latest), rows = value(await f.service.list(owner, "openai"));
  const old = rows.find(row => row.id === f.id); expect(old).toBeDefined();
  expect(old?.revisions?.latest).toBeUndefined(); expect(old?.revisions?.reviewed?.commit).toBe(oldCommit);
  const ready = value(await f.prepare({ kind: "reviewed", commit: oldCommit })); expect(ready.skill.commit).toBe(oldCommit);
  value(await f.service.cancel(owner));
  expect(await f.prepare({ kind: "latest", commit: oldCommit })).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
});

it.each([{ kind: "latest", commit: oldCommit }, { kind: "reviewed", commit: headCommit }])("a selected commit is an identity assertion, never an arbitrary revision selector: %j", async selection => {
  const f = revisionFixture(); expect(await f.prepare(selection)).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" }); expect(f.stages()).toEqual([]);
});

it.each([null, {}, { kind: "pinned", commit: oldCommit }, { kind: "reviewed", commit: "main" }, { kind: "reviewed", commit: oldCommit, path: "other" }, { kind: "reviewed", commit: oldCommit, approved: true }])("Main rejects malformed or authority-bearing selectors %j", async selection => {
  const f = revisionFixture(); expect(await f.prepare(selection)).toMatchObject({ ok: false, code: "FORBIDDEN" }); expect(f.stages()).toEqual([]);
});

it.each([undefined, "retired-policy"])("exact bytes cannot reuse a review under missing or different policy %s", async invalidPolicy => {
  const f = revisionFixture("changed", review => Object.assign(review, { policyVersion: invalidPolicy }));
  const skill: ExternalSkill = { id: f.id, sourceId: "openai", upstreamName: "synthetic-text", description: "Synthetic", bundle: { name: "synthetic", license: "MIT" }, repository: "openai/plugins", path: skillPath, commit: oldCommit, files: f.inventory, licenses: [], review: "unreviewed", blockers: ["REVIEW_REQUIRED"] };
  expect(evaluateExternalSkill(skill, f.oldPayload, [f.review]).blockers).toContain("REVIEW_REQUIRED");
  expect(await f.prepare({ kind: "reviewed", commit: oldCommit })).toMatchObject({ ok: false, code: "REVIEW_REQUIRED" }); expect(f.stages()).toEqual([]);
});

it("a different content digest cannot be blessed by selecting a reviewed commit", async () => {
  const f = revisionFixture("changed", review => { review.contentSha256 = "0".repeat(64); });
  expect(await f.prepare({ kind: "reviewed", commit: oldCommit })).toMatchObject({ ok: false, code: "REVIEW_REQUIRED" }); expect(f.stages()).toEqual([]);
});

it("installed identity comes from verified committed bytes, independently of current latest identity", async () => {
  const f = revisionFixture(), ready = value(await f.prepare({ kind: "reviewed", commit: oldCommit }));
  value(await f.service.commit(owner, ready.token));
  let row = value(await f.service.list(owner, "openai")).find(item => item.id === f.id)!;
  expect(row.revisions).toMatchObject({ latest: { commit: headCommit }, installed: { commit: oldCommit, contentSha256: ready.contentSha256, enabled: false, policyVersion } });
  fs.appendFileSync(path.join(f.storage.dataRoot, "skills", f.id, "content", "SKILL.md"), "untrusted change");
  row = value(await f.service.list(owner, "openai")).find(item => item.id === f.id)!;
  expect(row.revisions?.installed).toBeUndefined(); expect(row.revisions?.installedError).toBe("STATE_INVALID");
});

it("catalog refresh revokes a prepared reviewed revision token without advancing its approved identity", async () => {
  const f = revisionFixture(), ready = value(await f.prepare({ kind: "reviewed", commit: oldCommit }));
  const rows = value(await f.service.list(owner, "openai", true)); expect(rows.find(row => row.id === f.id)?.revisions?.reviewed?.commit).toBe(oldCommit);
  expect(await f.service.commit(owner, ready.token)).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" }); expect(f.stages()).toEqual([]);
});
