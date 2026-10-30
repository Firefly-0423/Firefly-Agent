import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentDigest, draftReview } from "../../../scripts/security/external-skill-review-draft.mjs";
import { digestExternalFiles, evaluateExternalSkill, isExternalSkillReview } from "./external-review";
import { externalSkillId } from "./external-policy";
import { createExternalFixture } from "./testing/external-fixtures";

const gitHash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const root = "skills/synthetic-notes";
const payload = new Map(Object.entries({
  "SKILL.md": "---\nname: synthetic-notes\ndescription: Synthetic.\nmodes:\n  - work\neffectKind: read\n---\nSummarize the note.\n",
  "LICENSE": createExternalFixture().expectedFiles.LICENSE,
  "NOTICE.md": "Synthetic attribution.\n",
}).map(([relative, text]) => [root + "/" + relative, Buffer.from(text)]));
const blobs = new Map([...payload].map(([path, bytes]) => [path, gitHash(bytes)]));

describe("external skill review draft", () => {
  it("computes the same digest as Main and a draft Main accepts once a reviewer fills in the name", () => {
    const draft = draftReview({ sourceId: "firefly", commit: "c".repeat(40), path: root, payload, blobs, reviewedAt: "2026-10-29T00:00:00.000Z" });
    const files = [...payload].map(([path, bytes]) => ({ path, blobSha1: blobs.get(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }));
    expect(contentDigest(files)).toBe(digestExternalFiles(files));
    expect(draft).toMatchObject({ policyVersion: "firefly-native-v1", native: { modes: ["work"], effectKind: "read" }, licenses: [{ spdx: "MIT" }] });
    expect(isExternalSkillReview(draft)).toBe(false); // an unedited draft names no reviewer and approves nothing
    const review = { ...draft, reviewer: "synthetic-test-only" };
    expect(isExternalSkillReview(review)).toBe(true);
    const skill = { id: externalSkillId("firefly", "Firefly-0423/firefly-skills", root), sourceId: "firefly", upstreamName: "synthetic-notes",
      description: "Synthetic.", repository: "Firefly-0423/firefly-skills", path: root, commit: draft.commit, bundle: { name: "synthetic" },
      files, licenses: [], review: "unreviewed", blockers: ["REVIEW_REQUIRED"] };
    expect(evaluateExternalSkill(skill, payload, [review]).review).toBe("approved");
  });

  it("drafts third-party entries under the instruction-only policy, without Firefly metadata", () => {
    const draft = draftReview({ sourceId: "anthropic", commit: "c".repeat(40), path: root, payload, blobs });
    expect(draft.policyVersion).toBe("firefly-instruction-only-v1");
    expect(draft).not.toHaveProperty("native");
  });
});
