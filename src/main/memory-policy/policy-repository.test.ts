import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSchema } from "../memory-core/schema";
import { SourceLedger } from "../memory-core/source-ledger";
import { canonicalJson } from "../memory-core/repository-types";
import type { BoundSourceRef } from "../../shared/memory-contracts";
import { claimSubjectKeys, PolicyRepository } from "./policy-repository";
import { extractMaintenance, MAINTENANCE_VERSION, type MaintenanceClaim } from "./maintenance-extractor";

const SCOPE = "scope-a";
const ACTOR = "actor-a";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const key = Buffer.from(randomBytes(32));
  initializeSchema(db, "policy-repository-test");
  const ledger = new SourceLedger(db, key);
  let now = 10_000;
  const policy = new PolicyRepository(db, key, undefined, () => now);

  function command(kind: string, body: Record<string, unknown>, commandId = randomUUID()) {
    return policy.execute({ kind, scopeKey: SCOPE, commandId, body });
  }

  function source(
    text: string,
    options: { role?: "user" | "assistant" | "system"; trust?: string; occurredAt?: number | null } = {},
  ): BoundSourceRef {
    const role = options.role ?? "user";
    const trust = options.trust ?? "direct-user-event";
    const identity = { providerId: "synthetic", sessionId: "session-a", messageId: randomUUID() };
    const head = ledger.execute({
      kind: "reserve",
      scopeKey: SCOPE,
      commandId: randomUUID(),
      body: { identity, expectedRef: null },
    }) as { sourceId: string; operationId: string };
    const state = "live";
    const fingerprint = createHash("sha256").update(canonicalJson({ text, state, role, trust })).digest("hex");
    const occurredAt = options.occurredAt === null ? undefined : options.occurredAt ?? 1_000;
    return ledger.execute({
      kind: "finish",
      scopeKey: SCOPE,
      commandId: randomUUID(),
      body: {
        sourceId: head.sourceId,
        operationId: head.operationId,
        observation: {
          ...identity,
          contentRevision: 1,
          generation: randomUUID(),
          state,
          role,
          trust,
          fingerprint,
          ...(occurredAt === undefined ? {} : { occurredAt }),
        },
      },
    }) as BoundSourceRef;
  }

  const direct = { kind: "direct", attribute: "shell", value: "bash", reason: "direct-preference", text: "I prefer bash" };

  function ingest(ref: BoundSourceRef, overrides: Record<string, unknown> = {}) {
    return command("ingest", {
      actorKey: ACTOR,
      sourceRef: ref,
      generation: 0,
      extraction: direct,
      policyVersion: "main-preferences-v1",
      baseline: [],
      ...overrides,
    }) as Record<string, unknown>;
  }

  function event(body: Record<string, unknown>) {
    return command("event", { actorKey: ACTOR, generation: 0, nonce: randomUUID(), ...body }) as Record<string, unknown>;
  }

  return { db, key, ledger, policy, command, source, ingest, event, direct };
}

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function fresh() {
  const value = fixture();
  open.push(value.db);
  return value;
}

function claim(overrides: Partial<MaintenanceClaim> = {}): MaintenanceClaim {
  return { attribute: "shell", value: "bash", context: "default", cardinality: "one", operation: "assert", ...overrides };
}

describe("claimSubjectKeys", () => {
  it("returns one deterministic global key and adds a distinct project-scoped key", () => {
    const global = claimSubjectKeys(ACTOR, claim());
    expect(global).toHaveLength(1);
    expect(global[0]).toMatch(/^actor-attribute-[a-f0-9]{64}$/);
    expect(claimSubjectKeys(ACTOR, claim())).toEqual(global);

    const project = `project-${"a".repeat(64)}`;
    const scoped = claimSubjectKeys(ACTOR, claim(), project);
    expect(scoped).toHaveLength(2);
    expect(scoped[0]).toBe(global[0]);
    expect(scoped[1]).not.toBe(global[0]);
    expect(scoped[1]).toMatch(/^actor-attribute-[a-f0-9]{64}$/);
  });

  it("does not project non-project attributes or explicit work/personal contexts", () => {
    const project = `project-${"a".repeat(64)}`;
    expect(claimSubjectKeys(ACTOR, claim({ attribute: "language", value: "en" }), project)).toHaveLength(1);
    expect(claimSubjectKeys(ACTOR, claim({ context: "work" }), project)).toHaveLength(1);
  });
});

describe("PolicyRepository commands", () => {
  it("reports the current suppression generation and rejects unknown commands", () => {
    const f = fresh();
    expect(f.command("generation", { actorKey: ACTOR })).toBe(0);
    expect(() => f.command("not-a-command", { actorKey: ACTOR })).toThrow("MEMORY_INPUT_INVALID");
  });

  it("validates candidate pagination and generation", () => {
    const f = fresh();
    for (const limit of [0, 102, 1.5, "2"]) {
      expect(() => f.command("candidates", { actorKey: ACTOR, generation: 0, limit, after: "" })).toThrow("MEMORY_INPUT_INVALID");
    }
    expect(() => f.command("candidates", { actorKey: ACTOR, generation: 1, limit: 10, after: "" })).toThrow("MEMORY_POLICY_SUPPRESSED");
    expect(f.command("candidates", { actorKey: ACTOR, generation: 0, limit: 10, after: "" })).toEqual([]);
  });

  it("activates a trusted direct preference and exposes it through recall, baseline and audit", () => {
    const f = fresh();
    const ref = f.source("I prefer bash");
    const result = f.ingest(ref);
    expect(result.status).toBe("active");
    expect(result.factId).toEqual(expect.any(String));
    expect(result.factRevision).toBe(1);

    const recalled = f.command("recall", { actorKey: ACTOR }) as Array<Record<string, unknown>>;
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ assertion: "I prefer bash", scope: "global", revision: 1 });

    const baseline = f.command("baseline", { actorKey: ACTOR }) as Array<Record<string, unknown>>;
    expect(baseline).toEqual([{ factId: result.factId, revision: 1, subjectKey: recalled[0].subjectKey }]);

    const audit = f.command("audit", { actorKey: ACTOR, factId: result.factId }) as Record<string, unknown>;
    expect(audit.status).toBe("eligible");
    expect(audit.supports).toHaveLength(1);
    expect(f.command("candidates", { actorKey: ACTOR, generation: 0, limit: 10, after: "" })).toEqual([]);
  });

  it("treats an independent same-value source as duplicate support, not a new fact", () => {
    const f = fresh();
    const first = f.ingest(f.source("I prefer bash"));
    const subjectKey = (f.command("baseline", { actorKey: ACTOR }) as Array<Record<string, unknown>>)[0].subjectKey as string;
    const second = f.ingest(f.source("I prefer bash"), {
      baseline: [{ factId: first.factId, revision: 1, subjectKey }],
    });
    expect(second).toMatchObject({ status: "active", factId: first.factId, reason: "duplicate-support" });
    expect(f.command("baseline", { actorKey: ACTOR })).toHaveLength(1);
    const audit = f.command("audit", { actorKey: ACTOR, factId: first.factId }) as Record<string, unknown>;
    expect(audit.supports).toHaveLength(2);
  });

  it("keeps untrusted and future sources as candidates", () => {
    const f = fresh();
    const untrusted = f.source("I prefer bash", { trust: "history" });
    expect(f.ingest(untrusted)).toMatchObject({ status: "candidate", candidateRevision: 1, reason: "untrusted-origin" });
    expect(f.command("recall", { actorKey: ACTOR })).toEqual([]);

    const future = f.source("I prefer bash", { occurredAt: 20_000 });
    expect(f.ingest(future)).toMatchObject({ status: "candidate", reason: "future-source" });
  });

  it("requires the current baseline before a competing value can be confirmed", () => {
    const f = fresh();
    const first = f.ingest(f.source("I prefer bash"));
    const subjectKey = (f.command("baseline", { actorKey: ACTOR }) as Array<Record<string, unknown>>)[0].subjectKey as string;
    const stale = f.ingest(f.source("I prefer bash"));
    expect(stale).toMatchObject({ status: "candidate", reason: "stale-base" });

    const freshBaseline = f.ingest(f.source("I prefer bash"), {
      baseline: [{ factId: first.factId, revision: 1, subjectKey }],
    });
    expect(freshBaseline).toMatchObject({ status: "active", factId: first.factId, reason: "duplicate-support" });
  });

  it("rejects wrong policy versions and non-canonical extraction payloads", () => {
    const f = fresh();
    const ref = f.source("I prefer bash");
    expect(() => f.ingest(ref, { policyVersion: "other" })).toThrow("MEMORY_POLICY_VERSION_INVALID");
    expect(() => f.ingest(ref, { extraction: { ...f.direct, value: "cmd" } })).toThrow("MEMORY_INPUT_INVALID");
  });

  it("integrates rejected maintenance extractions and validates project and version inputs", () => {
    const f = fresh();
    const ref = f.source("I prefer bash");
    const rejected = f.command("integrate", {
      actorKey: ACTOR,
      generation: 0,
      sourceRef: ref,
      extraction: { kind: "rejected", reason: "secret" },
      baseline: [],
      policyVersion: MAINTENANCE_VERSION,
    });
    expect(rejected).toEqual({ items: [{ status: "rejected", reason: "secret" }] });

    expect(() => f.command("integrate", {
      actorKey: ACTOR,
      generation: 0,
      sourceRef: ref,
      extraction: extractMaintenance("I prefer bash"),
      baseline: [],
      policyVersion: "other",
    })).toThrow("MEMORY_POLICY_VERSION_INVALID");

    expect(() => f.command("integrate", {
      actorKey: ACTOR,
      generation: 0,
      sourceRef: ref,
      extraction: extractMaintenance("I prefer bash"),
      baseline: [],
      policyVersion: MAINTENANCE_VERSION,
      projectKey: "not-a-project",
    })).toThrow("MEMORY_PROJECT_INVALID");
  });

  it("activates a trusted maintenance claim", () => {
    const f = fresh();
    const text = "I prefer bash";
    const extraction = extractMaintenance(text);
    expect(extraction.kind).toBe("claims");
    const result = f.command("integrate", {
      actorKey: ACTOR,
      generation: 0,
      sourceRef: f.source(text),
      extraction,
      baseline: [],
      policyVersion: MAINTENANCE_VERSION,
    }) as { items: Array<Record<string, unknown>> };
    expect(result.items).toEqual([expect.objectContaining({ status: "active", factRevision: 1 })]);
    expect(f.command("recall", { actorKey: ACTOR })).toHaveLength(1);
  });

  it("rejects, revises and confirms candidates with revision checks", () => {
    const f = fresh();
    const candidate = f.ingest(f.source("I prefer bash", { trust: "history" }));
    const candidateId = candidate.candidateId as string;

    expect(() => f.event({ kind: "reject", candidateId, revision: 2 })).toThrow("MEMORY_REVISION_CONFLICT");
    expect(f.event({ kind: "reject", candidateId, revision: 1 })).toEqual({
      status: "rejected",
      candidateId,
      candidateRevision: 2,
    });
    expect(f.command("candidates", { actorKey: ACTOR, generation: 0, limit: 10, after: "" })).toEqual([]);

    const second = f.ingest(f.source("I prefer bash", { trust: "history" }));
    const token = f.event({ kind: "confirm", candidateId: second.candidateId, revision: 1, sourceRef: f.source("I confirm this fact") });
    expect(token).toMatchObject({ status: "active", factRevision: 1 });
    expect(f.command("recall", { actorKey: ACTOR })).toHaveLength(1);
  });

  it("refuses confirmation from the same source as the candidate", () => {
    const f = fresh();
    const ref = f.source("I prefer bash", { trust: "history" });
    const candidate = f.ingest(ref);
    expect(() => f.event({ kind: "confirm", candidateId: candidate.candidateId, revision: 1, sourceRef: ref }))
      .toThrow("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
  });

  it("forgets an active fact, blocks its source and clears recall", () => {
    const f = fresh();
    const ref = f.source("I prefer bash");
    const active = f.ingest(ref);
    expect(f.command("recall", { actorKey: ACTOR })).toHaveLength(1);

    expect(f.event({ kind: "forget", factId: active.factId, revision: 1 }))
      .toEqual({ status: "forgotten", factId: active.factId, factRevision: 1 });
    expect(f.command("recall", { actorKey: ACTOR })).toEqual([]);
    expect(f.ingest(ref, { generation: 1 })).toEqual({ status: "suppressed", reason: "forgotten" });
  });

  it("reports missing facts and refuses sources not captured by the ledger", () => {
    const f = fresh();
    expect(() => f.command("audit", { actorKey: ACTOR, factId: "missing-fact" })).toThrow("MEMORY_FACT_NOT_FOUND");

    const unregistered = {
      sourceId: "source-missing",
      revision: 1,
      binding: { providerId: "synthetic", sessionId: "session-a", messageId: "m", contentRevision: 1, generation: "g" },
    } as BoundSourceRef;
    expect(() => f.command("naturalSnapshot", { actorKey: ACTOR, sourceRef: unregistered })).toThrow("MEMORY_SOURCE_INVALID");
  });
});
