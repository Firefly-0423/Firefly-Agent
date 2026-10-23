import type { ExternalSkillSelection, ExternalSkillSourceId } from "../../shared/external-skills";
import type { ExternalSkillReview } from "./external-types";
import { EXTERNAL_SOURCES, externalSkillId } from "./external-policy";
import { isExternalSkillReview } from "./external-review";

export function isExternalSkillSelection(value: unknown): value is ExternalSkillSelection {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === 2 && Reflect.ownKeys(value).every(key => key === "kind" || key === "commit") &&
    "kind" in value && (value.kind === "latest" || value.kind === "reviewed") &&
    "commit" in value && typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit);
}

/** Select only application-maintained approvals under the current policy. Ambiguity fails closed. */
export function reviewedExternalSkill(sourceId: ExternalSkillSourceId, id: string, reviews: readonly ExternalSkillReview[]): ExternalSkillReview | undefined {
  const matching = reviews.filter(review => isExternalSkillReview(review) && review.sourceId === sourceId &&
    externalSkillId(sourceId, EXTERNAL_SOURCES[sourceId].repository, review.path) === id)
    .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt));
  const latest = matching[0];
  if (!latest || matching.filter(review => Date.parse(review.reviewedAt) === Date.parse(latest.reviewedAt)).length !== 1 ||
    matching.filter(review => review.commit === latest.commit && review.contentSha256 === latest.contentSha256).length !== 1) return undefined;
  return latest;
}
