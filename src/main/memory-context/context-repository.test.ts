import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSchema } from "../memory-core/schema";
import { canonicalJson } from "../memory-core/repository-types";
import type { BoundSourceRef } from "../../shared/memory-contracts";
import { ContextRepository, parseSourceDependencies } from "./context-repository";
import { OPENROUTER_EXPENSE_SCOPE } from "./openrouter-bounded";

const SCOPE = "scope-a";
const owner = { actorKey: "actor-a", providerId: "provider-a", sessionId: "session-a", bootId: "boot-a" };
const exactCounter = {
  providerId: "provider-a",
  model: "model-a",
  transport: "openai",
  framingVersion: "framing-v1",
  mode: "exact",
  inputTypes: ["text"],
};

function boundRef(overrides: Record<string, unknown> = {}): BoundSourceRef {
  return {
    sourceId: "source-1",
    revision: 1,
    binding: { providerId: "provider-a", sessionId: "session-a", messageId: "message-1", contentRevision: 1, generation: "generation-1" },
    ...overrides,
  } as BoundSourceRef;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  const key = Buffer.from(randomBytes(32));
  initializeSchema(db, "context-repository-test");
  const repository = new ContextRepository(db, key, undefined, () => 10_000);

  function write(kind: string, body: Record<string, unknown>) {
    return repository.execute({ kind, scopeKey: SCOPE, commandId: randomUUID(), body });
  }

  function read(kind: string, body: Record<string, unknown>) {
    return repository.execute({ kind, scopeKey: SCOPE, body });
  }

  function snapshotBody(overrides: Record<string, unknown> = {}) {
    return {
      ...owner,
      generation: 0,
      sourceDeps: [],
      factRefs: [],
      snapshotId: "snapshot-1",
      requiredSources: [],
      requestDigest: "a".repeat(64),
      counterIdentity: exactCounter,
      promptTokens: 5,
      inputLimit: 10,
      ...overrides,
    };
  }

  return { db, key, repository, write, read, snapshotBody };
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

describe("parseSourceDependencies", () => {
  it("parses bound source refs with subject keys, derived refs and a secret exclusion", () => {
    const subject = `actor-attribute-${"b".repeat(64)}`;
    const dependency = { sourceRef: boundRef(), subjectKeys: [subject], derivedRefs: [boundRef({ sourceId: "source-2" })], excludeReason: "secret" };
    expect(parseSourceDependencies([dependency])).toEqual([dependency]);
  });

  it("accepts null subjectKeys/derivedRefs and omits excludeReason when absent", () => {
    expect(parseSourceDependencies([{ sourceRef: boundRef(), subjectKeys: null, derivedRefs: null }])).toEqual([
      { sourceRef: boundRef(), subjectKeys: null, derivedRefs: null },
    ]);
  });

  it("rejects non-array values, oversized lists and every malformed field", () => {
    expect(() => parseSourceDependencies(null)).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => parseSourceDependencies(new Array(1001).fill({ sourceRef: boundRef(), subjectKeys: null, derivedRefs: null })))
      .toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    const base = { sourceRef: boundRef(), subjectKeys: null, derivedRefs: null };

    expect(() => parseSourceDependencies([{ ...base, subjectKeys: ["not-a-subject"] }])).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => parseSourceDependencies([{ ...base, excludeReason: "other" }])).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => parseSourceDependencies([{ ...base, sourceRef: { ...boundRef(), span: { start: 0, end: 1 } } }]))
      .toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => parseSourceDependencies([{ ...base, sourceRef: { sourceId: "source-1", revision: 1 } }]))
      .toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => parseSourceDependencies([{ ...base, sourceRef: "/" }])).toThrow("MEMORY_INPUT_INVALID");
  });
});

describe("ContextRepository snapshots", () => {
  it("stores an empty exact snapshot, validates it and allows a permit", () => {
    const f = fresh();
    expect(f.write("snapshot", f.snapshotBody())).toEqual({ snapshotId: "snapshot-1", generation: 0 });
    expect(f.read("validateSnapshot", { ...owner, snapshotId: "snapshot-1" })).toEqual({ valid: true });
    expect(f.write("permit", { ...owner, snapshotId: "snapshot-1", permitId: "permit-1", requestDigest: "a".repeat(64) }))
      .toEqual({ permitId: "permit-1" });
  });

  it("rejects a permit whose request digest no longer matches", () => {
    const f = fresh();
    f.write("snapshot", f.snapshotBody());
    expect(() => f.write("permit", { ...owner, snapshotId: "snapshot-1", permitId: "permit-1", requestDigest: "b".repeat(64) }))
      .toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
  });

  it("refuses a response snapshot that has not been claimed", () => {
    const f = fresh();
    f.write("snapshot", f.snapshotBody());
    expect(() => f.read("validateResponse", { ...owner, snapshotId: "snapshot-1" }))
      .toThrow("MEMORY_CONTEXT_RESPONSE_UNSENT");
  });

  it("returns baseline and inspect views for an empty snapshot", () => {
    const f = fresh();
    expect(f.read("baseline", { ...owner, sourceRefs: [], factRefs: [] }))
      .toEqual({ generation: 0, facts: [], recallDeps: [] });
    expect(f.read("inspect", { ...owner, generation: 0, sourceDeps: [], factRefs: [] }))
      .toEqual({ generation: 0, sourceStates: [], facts: [], recallDeps: [] });
  });

  it("enforces budget, digest, required-source and counter rules", () => {
    const f = fresh();
    expect(() => f.write("snapshot", f.snapshotBody({ promptTokens: 11 }))).toThrow("MEMORY_CONTEXT_OVER_BUDGET");
    expect(() => f.write("snapshot", f.snapshotBody({ requestDigest: "not-a-digest" }))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => f.write("snapshot", f.snapshotBody({ requiredSources: ["missing-source"] })))
      .toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => f.write("snapshot", f.snapshotBody({ counterIdentity: { ...exactCounter, mode: "estimate" } })))
      .toThrow("MEMORY_CONTEXT_BUDGET_UNPROVEN");
    expect(() => f.write("snapshot", f.snapshotBody({ admissionMode: "other" }))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
  });

  it("supports bounded snapshots for the production estimate identity", () => {
    const f = fresh();
    const counterIdentity = {
      providerId: "openrouter",
      model: "openai/gpt-6-luna",
      transport: "responses",
      framingVersion: "bounded-v1",
      mode: "estimate",
      inputTypes: ["text", "image"],
    };
    const bounded = {
      admissionMode: "bounded",
      counterIdentity,
      estimates: { estimatedPromptTokens: 5, estimatedSTokens: 1, selectionInputLimit: 10 },
    };
    const boundedBody = (overrides: Record<string, unknown> = {}) => {
      const body = f.snapshotBody({ ...bounded, ...overrides });
      delete (body as Record<string, unknown>).promptTokens;
      delete (body as Record<string, unknown>).inputLimit;
      return body;
    };
    expect(f.write("snapshot", boundedBody({ snapshotId: "snapshot-bounded" })))
      .toEqual({ snapshotId: "snapshot-bounded", generation: 0 });

    expect(() => f.write("snapshot", boundedBody({
      snapshotId: "snapshot-too-large",
      estimates: { estimatedPromptTokens: 11, estimatedSTokens: 1, selectionInputLimit: 10 },
    }))).toThrow("MEMORY_CONTEXT_OVER_BUDGET");

    expect(() => f.write("snapshot", boundedBody({
      snapshotId: "snapshot-unsupported",
      counterIdentity: { ...counterIdentity, providerId: "someone-else" },
    }))).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  });

  it("denies unknown snapshots and missing summaries", () => {
    const f = fresh();
    expect(() => f.read("validateSnapshot", { ...owner, snapshotId: "missing" }))
      .toThrow("MEMORY_CONTEXT_RECORD_DENIED");
    expect(() => f.read("summaryGet", { ...owner, summaryId: "missing" }))
      .toThrow("MEMORY_CONTEXT_RECORD_DENIED");
  });
});

describe("ContextRepository validation and isolation", () => {
  it("rejects malformed source dependencies during inspect", () => {
    const f = fresh();
    expect(() => f.read("inspect", { ...owner, generation: 0, sourceDeps: [{}], factRefs: [] }))
      .toThrow("MEMORY_INPUT_INVALID");
  });

  it("rejects dependencies whose source is unknown to the ledger", () => {
    const f = fresh();
    expect(() => f.read("inspect", {
      ...owner,
      generation: 0,
      sourceDeps: [{ sourceRef: boundRef(), subjectKeys: null, derivedRefs: null }],
      factRefs: [],
    })).toThrow("MEMORY_SOURCE_INVALID");
  });

  it("denies non-expense commands on the OpenRouter expense scope", () => {
    const f = fresh();
    expect(() => f.repository.execute({
      kind: "baseline",
      scopeKey: OPENROUTER_EXPENSE_SCOPE,
      body: { ...owner, sourceRefs: [], factRefs: [] },
    })).toThrow("MEMORY_CONTEXT_COST_DENIED");
  });

  it("bounds summary leases and requires exactly one input kind", () => {
    const f = fresh();
    const lease = (overrides: Record<string, unknown> = {}) => ({
      ...owner,
      leaseId: "lease-1",
      generation: 0,
      sourceDeps: [],
      inputRefs: [],
      leaseMs: 1_000,
      ...overrides,
    });
    expect(() => f.write("summaryLease", lease({ leaseMs: 0 }))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => f.write("summaryLease", lease({ leaseMs: 300_001 }))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => f.write("summaryLease", lease())).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
    expect(() => f.write("summaryLease", lease({ admissionMode: "unbounded" }))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
  });

  it("rejects unknown commands after validating owner identity", () => {
    const f = fresh();
    expect(() => f.write("not-a-command", { ...owner })).toThrow("MEMORY_CONTEXT_COMMAND_INVALID");
    expect(() => f.repository.execute({ kind: "baseline", scopeKey: SCOPE, body: { actorKey: "bad actor" } }))
      .toThrow("MEMORY_INPUT_INVALID");
  });

  it("round-trips canonical source dependency shapes", () => {
    const dependency = { sourceRef: boundRef(), subjectKeys: null, derivedRefs: null };
    const parsed = parseSourceDependencies([dependency]);
    expect(canonicalJson(parsed)).toBe(canonicalJson([dependency]));
  });
});
