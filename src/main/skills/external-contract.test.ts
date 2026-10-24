import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import type {
  ExternalCommitted, ExternalPrepared, ExternalResult, ExternalSkill,
  ExternalSkillErrorCode, ExternalSkillFile, ExternalSkillSourceId, ExternalSkillsApi, LicenseEvidence, ExternalSkillSelection,
} from "../../shared/external-skills";
import type { ExternalHostSession, ExternalOwner, ExternalServiceDeps, ExternalSkillRecord, ExternalSkillReview } from "./external-types";

const modules = import.meta.glob<typeof import("./external-policy")>("./external-policy.ts");
async function policy() {
  const load = modules["./external-policy.ts"];
  expect(load, "Main must define the external skill boundary policy").toBeTypeOf("function");
  return load();
}

it("limits_and_contract locks every approved boundary, including fixed ten-minute approval", async () => {
  const { EXTERNAL_LIMITS } = await policy();
  expect(EXTERNAL_LIMITS.catalogBytes).toBe(1048576);
  expect(EXTERNAL_LIMITS.treeBytes).toBe(8388608);
  expect(EXTERNAL_LIMITS.files).toBe(200);
  expect(EXTERNAL_LIMITS.fileBytes).toBe(1048576);
  expect(EXTERNAL_LIMITS.totalBytes).toBe(10485760);
  expect(EXTERNAL_LIMITS.requestMs).toBe(15000);
  expect(EXTERNAL_LIMITS.prepareMs).toBe(120000);
  expect(EXTERNAL_LIMITS.jsonDepth).toBe(32);
  expect(EXTERNAL_LIMITS.candidates).toBe(2000);
  expect(EXTERNAL_LIMITS.treeEntries).toBe(50000);
  expect(EXTERNAL_LIMITS.concurrency).toBe(4);
  expect(EXTERNAL_LIMITS.transactions).toBe(1);
  expect(EXTERNAL_LIMITS.approvalMs).toBe(600000);
  expect(Object.isFrozen(EXTERNAL_LIMITS)).toBe(true);
});

it("limits_and_contract uses stable source/path IDs without borrowing a bundle version", async () => {
  const { externalSkillId, EXTERNAL_SOURCES } = await policy();
  for (const sourceId of ["openai", "anthropic"] as const) {
    const repository = EXTERNAL_SOURCES[sourceId].repository;
    const path = "skills/synthetic-text";
    const id = externalSkillId(sourceId, repository, path);
    expect(id).toMatch(/^external-(openai|anthropic)-[a-f0-9]{32}$/);
    expect(id.length).toBeLessThan(100);
    expect(id).toBe(`external-${sourceId}-${createHash("sha256").update(repository + "\n" + path).digest("hex").slice(0, 32)}`);
    expect(externalSkillId(sourceId, repository, path + "-other")).not.toBe(id);
    const skill: ExternalSkill = {
      id, sourceId, upstreamName: "Synthetic text", description: "Synthetic contract fixture",
      bundle: { name: "Synthetic bundle", version: "7.0.0", license: "MIT" },
      repository, path, commit: "a".repeat(40), licenses: [], files: [], review: "unreviewed", blockers: ["REVIEW_REQUIRED"],
    };
    expect(skill.bundle.version).toBe("7.0.0");
    expect(skill.version).toBeUndefined();
  }
  expect(EXTERNAL_SOURCES.openai).toEqual({ repository: "openai/plugins", owner: "openai", repo: "plugins", catalogPath: ".agents/plugins/marketplace.json" });
  expect(EXTERNAL_SOURCES.anthropic).toEqual({ repository: "anthropics/skills", owner: "anthropics", repo: "skills", catalogPath: ".claude-plugin/marketplace.json" });
  expect(Object.isFrozen(EXTERNAL_SOURCES)).toBe(true);
  expect(Object.isFrozen(EXTERNAL_SOURCES.openai)).toBe(true);
  expect(Object.isFrozen(EXTERNAL_SOURCES.anthropic)).toBe(true);
});

it("limits_and_contract keeps renderer and Main ownership contracts narrow", async () => {
  await policy();
  expectTypeOf<ExternalSkillSourceId>().toEqualTypeOf<"openai" | "anthropic">();
  expectTypeOf<ExternalSkillFile>().toEqualTypeOf<{ path: string; blobSha1: string; sha256: string; bytes: number }>();
  expectTypeOf<LicenseEvidence>().toEqualTypeOf<{ path: string; sha256: string; spdx: string | null; covers: string[] }>();
  expectTypeOf<ExternalCommitted>().toEqualTypeOf<{ id: string; enabled: false; contentSha256: string }>();
  expectTypeOf<ExternalPrepared>().toEqualTypeOf<{ token: string; expiresAt: number; skill: ExternalSkill; contentSha256: string }>();
  expectTypeOf<Parameters<ExternalSkillsApi["list"]>>().toEqualTypeOf<[ExternalSkillSourceId, boolean?]>();
  expectTypeOf<Parameters<ExternalSkillsApi["detail"]>>().toEqualTypeOf<[ExternalSkillSourceId, string, ExternalSkillSelection?]>();
  expectTypeOf<Parameters<ExternalSkillsApi["prepare"]>>().toEqualTypeOf<[ExternalSkillSourceId, string, ExternalSkillSelection?]>();
  expectTypeOf<Parameters<ExternalSkillsApi["commit"]>>().toEqualTypeOf<[string]>();
  expectTypeOf<Parameters<ExternalSkillsApi["cancel"]>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<ExternalSkillsApi["cancel"]>>().toEqualTypeOf<Promise<ExternalResult<{ status: "cancelled" | "idle" | "committing" }>>>();
  expectTypeOf<ExternalOwner>().toEqualTypeOf<{ webContentsId: number; frameProcessId: number; frameRoutingId: number; generation: number }>();
  expectTypeOf<ExternalHostSession>().toEqualTypeOf<{ runId: string; isPrimaryProcess: () => boolean }>();
  expectTypeOf<ExternalSkillReview["compatibility"]>().toEqualTypeOf<"instruction-only">();
  expectTypeOf<ExternalSkillRecord["schema"]>().toEqualTypeOf<1>();
  expectTypeOf<ExternalSkillRecord["status"]>().toEqualTypeOf<"prepared" | "committed">();
  expectTypeOf<ExternalServiceDeps["reviews"]>().toEqualTypeOf<readonly ExternalSkillReview[]>();
  expectTypeOf<ExternalSkillErrorCode>().toEqualTypeOf<
    "SOURCE_INVALID" | "CATALOG_INVALID" | "NETWORK_FAILED" | "RATE_LIMITED" | "REQUEST_TIMEOUT" |
    "PREPARE_TIMEOUT" | "LIMIT_EXCEEDED" | "PATH_INVALID" | "TREE_INVALID" | "BLOB_MISMATCH" |
    "DIGEST_MISMATCH" | "LICENSE_BLOCKED" | "DEPENDENCY_BLOCKED" | "REVIEW_REQUIRED" | "FORBIDDEN" |
    "TOKEN_INVALID" | "TOKEN_EXPIRED" | "STALE_SNAPSHOT" | "BUSY" | "TARGET_EXISTS" | "STORAGE_FAILED" |
    "STATE_INVALID" | "CANCELLED" | "ROLLBACK_FAILED"
  >();
});
