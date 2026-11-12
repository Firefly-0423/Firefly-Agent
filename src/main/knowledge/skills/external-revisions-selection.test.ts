import { expect, it } from "vitest";
import { createExternalFixture } from "./testing/external-fixtures";
import { externalSkillId } from "./external-policy";
import { reviewedExternalSkill } from "./external-revisions";

it("current-policy reviewed selection chooses the unique newest approval for the same stable source and path", () => {
  const old = createExternalFixture().review, next = { ...old, commit: "b".repeat(40), reviewedAt: "2026-10-09T00:00:00.000Z" };
  const id = externalSkillId("openai", "openai/plugins", old.path);
  expect(reviewedExternalSkill("openai", id, [old, next])).toEqual(next);
  expect(reviewedExternalSkill("anthropic", id, [next])).toBeUndefined();
  expect(reviewedExternalSkill("openai", id, [{ ...next, path: old.path + "-other" }])).toBeUndefined();
});

it("duplicate approvals and ambiguous newest timestamps do not expose a reviewed import choice", () => {
  const old = createExternalFixture().review, id = externalSkillId("openai", "openai/plugins", old.path);
  expect(reviewedExternalSkill("openai", id, [old, { ...old }])).toBeUndefined();
  expect(reviewedExternalSkill("openai", id, [old, { ...old, commit: "b".repeat(40) }])).toBeUndefined();
  expect(reviewedExternalSkill("openai", id, [{ ...old, policyVersion: "retired-policy" }])).toBeUndefined();
});

it("newest approval uses UTC instants across optional millisecond notation", () => {
  const old = { ...createExternalFixture().review, reviewedAt: "2026-10-08T00:00:00Z" };
  const next = { ...old, commit: "b".repeat(40), reviewedAt: "2026-10-08T00:00:00.001Z" };
  const id = externalSkillId("openai", "openai/plugins", old.path);
  expect(reviewedExternalSkill("openai", id, [old, next])).toEqual(next);
  expect(reviewedExternalSkill("openai", id, [old, { ...next, reviewedAt: "2026-10-08T00:00:00.000Z" }])).toBeUndefined();
});
