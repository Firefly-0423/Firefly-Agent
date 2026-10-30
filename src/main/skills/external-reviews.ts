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
  {
    policyVersion: "firefly-native-v1",
    sourceId: "firefly",
    commit: "6a0dab49c798ca08de12faa8279edfc139e72841",
    path: "skills/ai-cs-research",
    contentSha256: "0bca14ab9301530d7496922d29f7fd7c8f2916c8c164292c17c636b1ef0856ea",
    licenses: [{
      path: "skills/ai-cs-research/LICENSE",
      sha256: "19f8615650a1f98f1866e019542334808ae19731fa264f9e174de5e0cde7bb03",
      spdx: "MIT",
      covers: [
        "skills/ai-cs-research/LICENSE",
        "skills/ai-cs-research/NOTICE.md",
        "skills/ai-cs-research/SKILL.md",
        "skills/ai-cs-research/references/experiments-and-evaluation.md",
        "skills/ai-cs-research/references/papers-and-evidence.md",
        "skills/ai-cs-research/references/writing-and-review.md",
      ],
    }],
    compatibility: "instruction-only",
    reviewedAt: "2026-10-30T12:10:23.796Z",
    reviewer: "Claude Code static review for Firefly-0423",
    native: { modes: ["work", "code"], effectKind: "mutation" },
  },
  {
    policyVersion: "firefly-native-v1",
    sourceId: "firefly",
    commit: "6a0dab49c798ca08de12faa8279edfc139e72841",
    path: "skills/general-learning",
    contentSha256: "25c681d07383edbae8561bd0e88b40191d6b4b464c1eb1cf48040a212fbc20e0",
    licenses: [{
      path: "skills/general-learning/LICENSE",
      sha256: "19f8615650a1f98f1866e019542334808ae19731fa264f9e174de5e0cde7bb03",
      spdx: "MIT",
      covers: [
        "skills/general-learning/LICENSE",
        "skills/general-learning/NOTICE.md",
        "skills/general-learning/SKILL.md",
        "skills/general-learning/references/learning-artifacts.md",
        "skills/general-learning/references/practice-and-feedback.md",
        "skills/general-learning/references/question-banks-and-papers.md",
      ],
    }],
    compatibility: "instruction-only",
    reviewedAt: "2026-10-30T12:10:24.241Z",
    reviewer: "Claude Code static review for Firefly-0423",
    native: { modes: ["work"], effectKind: "mutation" },
  },
];
