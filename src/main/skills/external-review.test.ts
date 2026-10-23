import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExternalSkill, ExternalSkillFile, LicenseEvidence } from "../../shared/external-skills";
import type { ExternalSkillReview } from "./external-types";
import { externalSkillId, EXTERNAL_REVIEW_POLICY_VERSION } from "./external-policy";
import { createExternalFixture } from "./testing/external-fixtures";

const modules = import.meta.glob<typeof import("./external-review")>("./external-review.ts");
const registryModules = import.meta.glob<typeof import("./external-reviews")>("./external-reviews.ts");
async function evaluator() {
  const load = modules["./external-review.ts"];
  expect(load, "Main must enforce complete reviewed content before import eligibility").toBeTypeOf("function");
  return load();
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const gitHash = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const root = "plugins/synthetic/skills/synthetic-text";
const MIT = createExternalFixture().expectedFiles.LICENSE;
const ISC = 'Copyright (c) 2026 Synthetic Test Authors\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n';
const BSD = (three: boolean) => 'Copyright (c) 2026 Synthetic Test Authors\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n' + (three ? '3. Neither the name of Synthetic Test Authors nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n' : '') + '\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n';
const canonicalDigest = (files: readonly ExternalSkillFile[]) => hash(JSON.stringify([...files]
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.sha256, file.bytes])));
function fixture(extra: Record<string, string | Buffer> = {}) {
  const payload = new Map(Object.entries({
    "SKILL.md": "---\nname: synthetic-text\ndescription: A synthetic instruction.\n---\nRead references/guide.md and summarize the supplied text.\n",
    "LICENSE": MIT,
    "NOTICE.txt": "Synthetic author attribution. Preserve these exact bytes.\n",
    "references/guide.md": "# Guide\nUse only the text supplied by the user.\n",
    ...extra,
  }).map(([relative, bytes]) => [root + "/" + relative, Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes)]));
  const files = Array.from(payload, ([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes), blobSha1: gitHash(bytes) }));
  const skill: ExternalSkill = { id: externalSkillId("openai", "openai/plugins", root), sourceId: "openai",
    upstreamName: "synthetic-text", description: "Synthetic tests do not approve real upstream content.",
    repository: "openai/plugins", path: root, commit: "a".repeat(40), bundle: { name: "synthetic", license: "MIT" },
    files, licenses: [], review: "unreviewed", blockers: ["REVIEW_REQUIRED"] };
  const license: LicenseEvidence = { path: root + "/LICENSE", sha256: hash(MIT), spdx: "MIT", covers: files.map(file => file.path) };
  const review: ExternalSkillReview = { policyVersion: EXTERNAL_REVIEW_POLICY_VERSION, sourceId: skill.sourceId, path: skill.path, commit: skill.commit,
    contentSha256: canonicalDigest(files), licenses: [license], compatibility: "instruction-only",
    reviewedAt: "2026-10-08T00:00:00.000Z", reviewer: "synthetic-test-only" };
  return { skill, payload, review };
}
async function blocked(f: ReturnType<typeof fixture>, code: ExternalSkill["blockers"][number], reviews = [f.review]) {
  const { evaluateExternalSkill } = await evaluator();
  const result = evaluateExternalSkill(f.skill, f.payload, reviews);
  expect(result.review).not.toBe("approved");
  expect(result.blockers).toContain(code);
  expect(result.files).toEqual(f.skill.files);
  expect(Array.from(f.payload.keys())).toEqual(f.skill.files.map(file => file.path));
  return result;
}

describe("complete_review_required", () => {
  it("approves only the exact complete synthetic bytes and copies trusted license evidence without mutation", async () => {
    const f = fixture(), before = JSON.stringify(f);
    const { evaluateExternalSkill } = await evaluator();
    const result = evaluateExternalSkill(f.skill, f.payload, [f.review]);
    expect(result.review).toBe("approved");
    expect(result.blockers).toEqual([]);
    expect(result.licenses).toEqual(f.review.licenses);
    expect(result.licenses).not.toBe(f.review.licenses);
    expect(result.licenses[0].covers).not.toBe(f.review.licenses[0].covers);
    expect(JSON.stringify(f)).toBe(before);
    expect(result.version).toBeUndefined();
  });
  it("fails closed with an empty review registry despite a correct package license name", async () => {
    await blocked(fixture(), "REVIEW_REQUIRED", []);
  });
  it("cannot be bypassed by an upstream approved flag or confirmation-shaped extra field", async () => {
    const f = fixture(); f.skill.review = "approved"; f.skill.blockers = [];
    Object.assign(f.skill, { userConfirmed: true });
    await blocked(f, "REVIEW_REQUIRED", []);
  });
  it.each(["sourceId", "commit", "path", "contentSha256"] as const)("requires an exact review %s", async field => {
    const f = fixture(); Object.assign(f.review, { [field]: field === "sourceId" ? "anthropic" : field === "commit" ? "b".repeat(40) : field === "path" ? root + "-other" : "f".repeat(64) });
    await blocked(f, "REVIEW_REQUIRED");
  });
  it.each([
    ["commit", "a".repeat(39)], ["commit", "A".repeat(40)], ["commit", 123],
    ["contentSha256", "f".repeat(63)], ["contentSha256", "F".repeat(64)],
    ["path", "../escape"], ["compatibility", "executable"], ["reviewer", ""], ["reviewer", 3],
    ["reviewer", "name\nspoof"], ["reviewedAt", "not-a-date"], ["reviewedAt", "2026-02-30T00:00:00Z"],
    ["reviewedAt", 123], ["licenses", null], ["licenses", []],
  ])("rejects malformed static record %s=%s", async (field, value) => {
    const f = fixture(); Object.assign(f.review, { [field as string]: value });
    await blocked(f, "REVIEW_REQUIRED");
  });
  it("ignores a malformed neighboring review without granting approval or throwing", async () => {
    const f = fixture(); const { evaluateExternalSkill } = await evaluator();
    expect(evaluateExternalSkill(f.skill, f.payload, [null as unknown as ExternalSkillReview, f.review]).review).toBe("approved");
  });
  it("rejects two conflicting records rather than choosing the most permissive one", async () => {
    const f = fixture(), duplicate = structuredClone(f.review); duplicate.licenses[0].spdx = "ISC";
    const result = (await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review, duplicate]);
    expect(result.blockers).toContain("REVIEW_REQUIRED"); expect(result.review).not.toBe("approved");
  });
  it.each(["references/guide.md", "NOTICE.txt", "LICENSE", "SKILL.md"])("one-byte upstream %s changes invalidate the previous review", async relative => {
    const f = fixture(), key = root + "/" + relative, bytes = Buffer.concat([f.payload.get(key)!, Buffer.from("\n")]);
    f.payload.set(key, bytes); Object.assign(f.skill.files.find(file => file.path === key)!, { bytes: bytes.length, sha256: hash(bytes), blobSha1: gitHash(bytes) });
    await blocked(f, "REVIEW_REQUIRED");
  });
  it.each(["sha256", "bytes", "blobSha1"] as const)("verifies actual bytes rather than trusting declared %s", async field => {
    const f = fixture(); Object.assign(f.skill.files[0], { [field]: field === "bytes" ? 0 : "0".repeat(field === "blobSha1" ? 40 : 64) });
    f.review.contentSha256 = canonicalDigest(f.skill.files);
    await blocked(f, field === "blobSha1" ? "BLOB_MISMATCH" : "DIGEST_MISMATCH");
  });
  it("rejects an omitted payload file", async () => {
    const f = fixture(); f.payload.delete(f.skill.files[0].path);
    const result = (await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]);
    expect(result.blockers).toContain("DIGEST_MISMATCH"); expect(result.review).not.toBe("approved");
  });
  it("rejects extra payload bytes absent from the declared complete inventory", async () => {
    const f = fixture(); f.payload.set(root + "/scripts/run.sh", Buffer.from("echo should-never-run"));
    const result = (await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]);
    expect(result.blockers).toContain("DIGEST_MISMATCH"); expect(result.review).not.toBe("approved");
    expect(f.payload.has(root + "/scripts/run.sh")).toBe(true);
  });
  it("does not erase a preexisting informational-only dependency blocker", async () => {
    const f = fixture(); f.skill.blockers.push("DEPENDENCY_BLOCKED");
    await blocked(f, "DEPENDENCY_BLOCKED");
  });
});

describe("whole_item_or_none", () => {
  it.each(["scripts/run.py", "run.sh", "install.ps1", "bundle.zip", "font.woff", "image.png", "package.json", "manifest.json", ".claude-plugin/plugin.json", "hooks.json", "mcp.json", "apps/tool.md", "references/nested/guide.md", "references/code.ts", "README.md"])("retains and blocks unsupported file %s", async relative => {
    await blocked(fixture({ [relative]: "Synthetic unsupported payload.\n" }), "DEPENDENCY_BLOCKED");
  });
  it.each([Buffer.from([0xff, 0xfe]), Buffer.from("text\0binary"), Buffer.from("\x01binary")])("blocks non-text bytes even behind an allowed .md extension", async bytes => {
    await blocked(fixture({ "references/guide.md": bytes }), "DEPENDENCY_BLOCKED");
  });
  it.each([
    "---\nname: synthetic\nallowed-tools: [mcp__service__fetch]\n---\nText.\n",
    "---\nname: synthetic\nhooks: {before: run}\n---\nText.\n",
    "---\nname: synthetic\napps: [calendar]\n---\nText.\n",
    "---\nname: synthetic\ndependencies: [some-tool]\n---\nText.\n",
    "---python\nprint('never execute')\n---\nText.\n",
    "You must use the browser tool to retrieve the required input.\n",
    "Requires the build-chatgpt-app Skill before proceeding.\n",
    "First invoke another Skill: deployment-helper.\n",
    "Fetch https://example.invalid/required-guide before following these steps.\n",
    "Download the required font from https://example.invalid/font.woff.\n",
    "Run scripts/setup.sh before using this skill.\n",
    "Install dependencies with npm install.\n",
    "Read references/missing.md before proceeding.\n",
    "Read ../other-skill/SKILL.md before proceeding.\n",
    "[Required guide](references/nested/missing.md)\n",
    "Optional background: an article. You must fetch https://example.invalid/required-input.\n",
    "Uses RGB color values. Applied via python-pptx's RGBColor class.\n",
    "The required external API endpoint is https://example.invalid/data.\n",
  ])("blocks required dependencies declared in instruction text: %s", async body => {
    await blocked(fixture({ "SKILL.md": body }), "DEPENDENCY_BLOCKED");
  });
  it("permits named design references, ordinary downstream work and explicitly optional host capabilities", async () => {
    const f = fixture({ "SKILL.md": "Follow the default guidance of The Elements of Typographic Style.\nWrite frontend code for the user's brief.\nTake screenshots if your environment supports it. Use memory if available.\nOptional background: [an article](https://example.invalid/article).\n" });
    expect((await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]).review).toBe("approved");
  });
  it("permits supported top-level text references and preserves every byte", async () => {
    const f = fixture({ "references/extra.txt": "Text reference.\n" });
    const original = Array.from(f.payload, ([key, bytes]) => [key, hash(bytes)]);
    expect((await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]).review).toBe("approved");
    expect(Array.from(f.payload, ([key, bytes]) => [key, hash(bytes)])).toEqual(original);
  });
  it("does not accept a required ancestor license without an agreed safe import mapping", async () => {
    const f = fixture(), key = "plugins/synthetic/LICENSE", bytes = Buffer.from(MIT);
    f.payload.set(key, bytes); f.skill.files.push({ path: key, sha256: hash(bytes), blobSha1: gitHash(bytes), bytes: bytes.length });
    f.review.contentSha256 = canonicalDigest(f.skill.files); f.review.licenses[0] = { path: key, sha256: hash(bytes), spdx: "MIT", covers: f.skill.files.map(file => file.path) };
    await blocked(f, "DEPENDENCY_BLOCKED");
  });
  it.each(["../escape", "/absolute", "references/../guide.md", "references/CON.md"])("blocks unsafe content path %s", async relative => {
    await blocked(fixture({ [relative]: "Text.\n" }), "PATH_INVALID");
  });
  it("rejects case-colliding files", async () => {
    await blocked(fixture({ "references/Guide.md": "Text.\n" }), "PATH_INVALID");
  });
  it("requires SKILL.md in the selected complete directory", async () => {
    const f = fixture(); f.payload.delete(root + "/SKILL.md"); f.skill.files = f.skill.files.filter(file => !file.path.endsWith("/SKILL.md"));
    f.review.contentSha256 = canonicalDigest(f.skill.files); f.review.licenses[0].covers = f.skill.files.map(file => file.path);
    await blocked(f, "DEPENDENCY_BLOCKED");
  });
  it("blocks file-count and decoded-byte budgets before review", async () => {
    const extras = Object.fromEntries(Array.from({ length: 197 }, (_, index) => [`references/file-${index}.txt`, "Text."]));
    await blocked(fixture(extras), "LIMIT_EXCEEDED");
    await blocked(fixture({ "references/guide.md": Buffer.alloc(1048577, 65) }), "LIMIT_EXCEEDED");
  });
  it("blocks total decoded bytes across otherwise individually valid files", async () => {
    const extras = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`references/file-${index}.txt`, Buffer.alloc(1048576, 65)]));
    await blocked(fixture(extras), "LIMIT_EXCEEDED");
  });
  it("permits exactly 200 supported files and exactly 1 MiB decoded bytes per file", async () => {
    const extras = Object.fromEntries(Array.from({ length: 196 }, (_, index) => [`references/file-${index}.txt`, index === 0 ? Buffer.alloc(1048576, 65) : "Text."]));
    const f = fixture(extras);
    expect(f.skill.files).toHaveLength(200);
    expect((await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]).review).toBe("approved");
  });
  it("permits exactly 10 MiB complete decoded payload without relaxing any individual limit", async () => {
    const baseBytes = fixture().skill.files.reduce((total, file) => total + file.bytes, 0);
    const extras = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`references/file-${index}.txt`, Buffer.alloc(index === 9 ? 1048576 - baseBytes : 1048576, 65)]));
    const f = fixture(extras);
    expect(f.skill.files.reduce((total, file) => total + file.bytes, 0)).toBe(10485760);
    expect((await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]).review).toBe("approved");
  });
});

describe("license_scope_and_notice", () => {
  it.each([["MIT", MIT], ["ISC", ISC], ["BSD-2-Clause", BSD(false)], ["BSD-3-Clause", BSD(true)]])("permits exact reviewed full %s terms for all covered synthetic files", async (spdx, text) => {
    const f = fixture({ LICENSE: text }); f.review.licenses[0].sha256 = hash(text); f.review.licenses[0].spdx = spdx; f.skill.bundle.license = spdx;
    expect((await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]).review).toBe("approved");
  });
  it.each(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"])("rejects a %s label without full substantive terms", async spdx => {
    const f = fixture({ LICENSE: spdx + "\n" }); f.review.licenses[0].sha256 = hash(spdx + "\n"); f.review.licenses[0].spdx = spdx; f.skill.bundle.license = spdx;
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("distinguishes BSD clause count and rejects contradictory labeling", async () => {
    const f = fixture({ LICENSE: BSD(true) }); f.review.licenses[0].sha256 = hash(BSD(true)); f.review.licenses[0].spdx = "BSD-2-Clause";
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("accepts an exact adjacent-license pointer and a matching Skill SPDX declaration", async () => {
    for (const declaration of ["MIT", "Complete terms in LICENSE"]) {
      const f = fixture({ "SKILL.md": `---\nname: synthetic\nlicense: ${declaration}\n---\nUse only supplied text.\n` });
      expect((await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]).review).toBe("approved");
    }
  });
  it.each([null, "Proprietary", "Custom", "GPL-3.0", "Apache 2", "MIT OR ISC"])("blocks unapproved SPDX expression %s even with synthetic complete review", async spdx => {
    const f = fixture(); f.review.licenses[0].spdx = spdx;
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("rejects a license label without substantive license terms", async () => {
    const f = fixture({ LICENSE: "MIT License\n" }); f.review.licenses[0].sha256 = hash(f.payload.get(root + "/LICENSE")!);
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("rejects license evidence whose bytes do not match its digest", async () => {
    const f = fixture(); f.review.licenses[0].sha256 = "0".repeat(64);
    await blocked(f, "LICENSE_BLOCKED");
  });
  it.each(["NOTICE.txt", "references/guide.md", "LICENSE", "SKILL.md"])("requires reviewed license coverage for %s", async relative => {
    const f = fixture(); f.review.licenses[0].covers = f.review.licenses[0].covers.filter(path => path !== root + "/" + relative);
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("rejects wildcard coverage and evidence for nonexistent files", async () => {
    const f = fixture(); f.review.licenses[0].covers = [root + "/*"];
    await blocked(f, "LICENSE_BLOCKED");
    const g = fixture(); g.review.licenses[0].path = root + "/MISSING-LICENSE";
    await blocked(g, "LICENSE_BLOCKED");
  });
  it("blocks bundle/component ambiguity rather than borrowing the inner license name", async () => {
    const f = fixture(); f.skill.bundle.license = "Proprietary";
    await blocked(f, "LICENSE_BLOCKED");
  });
  it.each(["Proprietary", "Custom", "GPL-3.0", "Apache-2.0", "See ../LICENSE", 3])("blocks unresolved or contradictory Skill frontmatter license %s", async declaration => {
    const f = fixture({ "SKILL.md": `---\nname: synthetic\nlicense: ${declaration}\n---\nUse only supplied text.\n` });
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("retains and checks a second applicable license instead of ignoring it", async () => {
    const f = fixture({ "LICENSE.txt": "All rights reserved. Proprietary.\n" });
    f.review.licenses.push({ path: root + "/LICENSE.txt", sha256: hash(f.payload.get(root + "/LICENSE.txt")!), spdx: "Proprietary", covers: [root + "/LICENSE.txt"] });
    await blocked(f, "LICENSE_BLOCKED");
  });
  it("cannot silently ignore a license document omitted from the reviewed evidence", async () => {
    await blocked(fixture({ "LICENSE.txt": "MIT License\n" }), "LICENSE_BLOCKED");
  });
  it.each([
    ["path", 3], ["sha256", "short"], ["covers", null], ["covers", []], ["covers", [3]],
  ])("fails closed on malformed license schema %s", async (field, value) => {
    const f = fixture(); Object.assign(f.review.licenses[0], { [field as string]: value });
    const result = (await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]);
    expect(result.review).not.toBe("approved"); expect(result.blockers).toContain("REVIEW_REQUIRED");
  });
});

describe("canonical_digest_and_registry", () => {
  it("hashes sorted path/SHA256/decoded-byte tuples, independent of input order and blob identity", async () => {
    const f = fixture(), before = structuredClone(f.skill.files), { digestExternalFiles } = await evaluator();
    expect(digestExternalFiles(f.skill.files)).toBe(canonicalDigest(f.skill.files));
    expect(digestExternalFiles([...f.skill.files].reverse().map(file => ({ ...file, blobSha1: "b".repeat(40) })))).toBe(canonicalDigest(f.skill.files));
    expect(f.skill.files).toEqual(before);
    expect(digestExternalFiles([])).toBe(hash("[]"));
  });
  it.each(["path", "sha256", "bytes"] as const)("binds %s into the canonical digest", async field => {
    const f = fixture(), { digestExternalFiles } = await evaluator();
    const changed = structuredClone(f.skill.files); Object.assign(changed[0], { [field]: field === "path" ? root + "/NOTICE.md" : field === "sha256" ? "f".repeat(64) : 1 });
    expect(digestExternalFiles(changed)).not.toBe(digestExternalFiles(f.skill.files));
  });
  it("keeps production records exact-pinned and separate from synthetic approval records", async () => {
    const load = registryModules["./external-reviews.ts"];
    expect(load, "Main must own a static review table, never renderer-provided approval").toBeTypeOf("function");
    const { EXTERNAL_SKILL_REVIEWS } = await load();
    expect(EXTERNAL_SKILL_REVIEWS.every(review => !review.reviewer.includes("synthetic"))).toBe(true);
    expect(EXTERNAL_SKILL_REVIEWS.filter(review => review.sourceId === "openai")).toEqual([]);
    for (const review of EXTERNAL_SKILL_REVIEWS) {
      expect(review.commit).toMatch(/^[a-f0-9]{40}$/); expect(review.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(review.compatibility).toBe("instruction-only"); expect(review.reviewer.trim()).not.toBe("");
    }
  });
  it("updates the T1 synthetic fixture to the same canonical tuple preimage", async () => {
    const f = createExternalFixture();
    const tuples = Object.entries(f.expectedFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, bytes]) => [path, hash(bytes), Buffer.byteLength(bytes)]);
    expect(f.review.contentSha256).toBe(hash(JSON.stringify(tuples)));
  });
  it("rejects malformed runtime inventory paths without throwing or accepting them", async () => {
    const f = fixture(); (f.skill.files[0] as unknown as { path: unknown }).path = 3;
    const result = (await evaluator()).evaluateExternalSkill(f.skill, f.payload, [f.review]);
    expect(result.review).not.toBe("approved"); expect(result.blockers).toContain("PATH_INVALID");
  });
});
