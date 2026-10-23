import type { ExternalSkillReview } from "./external-types";

/** Main-maintained exact-file static reviews. Changes to commit, any file, or scope require a new review.
 * Review rationale and source/license preservation are in THIRD_PARTY_SKILL_REVIEWS.md.
 * No installation, activation, runtime compatibility or user confirmation is implied by this table.
 */
export const EXTERNAL_SKILL_REVIEWS: readonly ExternalSkillReview[] = [
  {
    policyVersion: "firefly-instruction-only-v1",
    sourceId: "anthropic",
    commit: "683bc88e56f3e09ba94f7055977f3d3aa499f202",
    path: "skills/frontend-design",
    contentSha256: "444b2331df1f7dc747db4f4ec6cd3d8a84a41c00855041336d424aeb8ca65589",
    licenses: [{
      path: "skills/frontend-design/LICENSE.txt",
      sha256: "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594",
      spdx: "Apache-2.0",
      covers: ["skills/frontend-design/LICENSE.txt", "skills/frontend-design/SKILL.md"],
    }],
    compatibility: "instruction-only",
    reviewedAt: "2026-10-08T04:42:50.000Z",
    reviewer: "Firefly T3 implementation static review",
  },
];
