import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExternalSkill, ExternalSkillFile, ExternalSkillSourceId } from "../../shared/external-skills";
import type { ExternalSkillReview } from "./external-types";
import { EXTERNAL_SOURCES, externalSkillId, reviewPolicyFor } from "./external-policy";
import { evaluateExternalSkill, isExternalSkillReview } from "./external-review";
import { createExternalFixture } from "./testing/external-fixtures";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const gitHash = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const MIT = createExternalFixture().expectedFiles.LICENSE;
const digest = (files: readonly ExternalSkillFile[]) => hash(JSON.stringify([...files]
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.sha256, file.bytes])));
const FIREFLY_FRONTMATTER = "modes:\n  - work\neffectKind: mutation\ntools:\n  - obsidian_read_file\n";

/** A synthetic Skill in `sourceId`'s repository; synthetic reviews never approve real upstream content. */
function fixture(sourceId: ExternalSkillSourceId, frontmatter = FIREFLY_FRONTMATTER, body = "Summarize the note the user names.\n") {
  const root = "skills/synthetic-notes", repository = EXTERNAL_SOURCES[sourceId].repository;
  const payload = new Map(Object.entries({
    "SKILL.md": `---\nname: synthetic-notes\ndescription: A synthetic Firefly Skill.\n${frontmatter}---\n${body}`,
    "LICENSE": MIT,
    "NOTICE.md": "Synthetic attribution.\n",
  }).map(([relative, text]) => [root + "/" + relative, Buffer.from(text)]));
  const files = Array.from(payload, ([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes), blobSha1: gitHash(bytes) }));
  const skill: ExternalSkill = { id: externalSkillId(sourceId, repository, root), sourceId, upstreamName: "synthetic-notes",
    description: "Synthetic.", repository, path: root, commit: "b".repeat(40), bundle: { name: "synthetic" },
    files, licenses: [], review: "unreviewed", blockers: ["REVIEW_REQUIRED"] };
  const review: ExternalSkillReview = { policyVersion: reviewPolicyFor(sourceId), sourceId, path: root, commit: skill.commit,
    contentSha256: digest(files), licenses: [{ path: root + "/LICENSE", sha256: hash(MIT), spdx: "MIT", covers: files.map(file => file.path) }],
    compatibility: "instruction-only", reviewedAt: "2026-10-29T00:00:00.000Z", reviewer: "synthetic-test-only",
    ...(sourceId === "firefly" ? { native: { modes: ["work" as const], effectKind: "mutation" as const, tools: ["obsidian_read_file"] } } : {}) };
  return { skill, payload, review };
}

describe("Firefly-native review policy", () => {
  it("approves a Firefly Skill with its Firefly metadata and carries exactly the reviewed values", () => {
    const f = fixture("firefly");
    const result = evaluateExternalSkill(f.skill, f.payload, [f.review]);
    expect(result.review).toBe("approved");
    expect(result.native).toEqual({ modes: ["work"], effectKind: "mutation", tools: ["obsidian_read_file"] });
    expect(result.native).not.toBe(f.review.native);
  });

  it("does not approve when the review pins different metadata from what the Skill declares", () => {
    const f = fixture("firefly");
    const result = evaluateExternalSkill(f.skill, f.payload, [{ ...f.review, native: { modes: ["work"], effectKind: "read", tools: ["obsidian_read_file"] } }]);
    expect(result.review).not.toBe("approved");
    expect(result.blockers).toContain("REVIEW_REQUIRED");
    expect(result.native).toBeUndefined();
  });

  it("never takes Firefly metadata from the incoming Skill object", () => {
    const f = fixture("firefly");
    const result = evaluateExternalSkill({ ...f.skill, native: { tools: ["run_shell"] } }, f.payload, []);
    expect(result.native).toBeUndefined();
  });

  it("refuses malformed Firefly fields instead of dropping them", () => {
    for (const frontmatter of ["modes:\n  - chat\n", "effectKind: anything\n", "tools: obsidian_read_file\n", "tools:\n  - Not A Tool\n"]) {
      const f = fixture("firefly", frontmatter);
      const result = evaluateExternalSkill(f.skill, f.payload, [f.review]);
      expect(result.review).toBe("blocked");
      expect(result.dependencyIssues).toContainEqual({ kind: "frontmatter", component: "firefly-metadata", path: "skills/synthetic-notes/SKILL.md" });
    }
  });

  it("keeps third-party sources on the instruction-only rules: no Firefly fields, and the tool heuristic still applies", () => {
    const fields = fixture("anthropic");
    expect(evaluateExternalSkill(fields.skill, fields.payload, [fields.review]).dependencyIssues).toContainEqual({ kind: "frontmatter", component: "modes", path: "skills/synthetic-notes/SKILL.md" });
    const toolBody = "Use the obsidian_read_file tool to open the note.\n";
    const third = fixture("anthropic", "", toolBody);
    expect(evaluateExternalSkill(third.skill, third.payload, [third.review]).dependencyIssues).toContainEqual({ kind: "instruction", component: "tool-or-runtime", path: "skills/synthetic-notes/SKILL.md" });
    const own = fixture("firefly", FIREFLY_FRONTMATTER, toolBody);
    expect(evaluateExternalSkill(own.skill, own.payload, [own.review]).review).toBe("approved");
  });

  it("accepts a review only under its source's policy, with Firefly metadata exactly when that policy is Firefly-native", () => {
    const own = fixture("firefly").review, third = fixture("anthropic", "").review;
    expect(isExternalSkillReview(own)).toBe(true);
    expect(isExternalSkillReview({ ...own, native: {} })).toBe(true);
    const { native: _native, ...withoutNative } = own;
    expect(isExternalSkillReview(withoutNative)).toBe(false);
    expect(isExternalSkillReview({ ...own, policyVersion: "firefly-instruction-only-v1" })).toBe(false);
    expect(isExternalSkillReview({ ...own, native: { ...own.native, grants: ["run_shell"] } })).toBe(false);
    expect(isExternalSkillReview(third)).toBe(true);
    expect(isExternalSkillReview({ ...third, native: {} })).toBe(false);
  });
});
