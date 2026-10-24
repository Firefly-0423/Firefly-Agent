import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeSchema } from "../memory-core/schema";
import { RecordCodec } from "../memory-core/record-codec";
import { Suppression } from "../memory-core/suppression";
import { TranscriptLedger, type TranscriptHead } from "./transcript-ledger";
import type { ContextOwner } from "./context-repository";

const SCOPE = "scope-a";
const owner: ContextOwner = { actorKey: "actor-a", providerId: "provider-a", sessionId: "session-a", bootId: "boot-a" };
const digest = (seed: string) => seed.padEnd(64, "0").slice(0, 64);

const fixtures: Array<{ db: DatabaseSync; root: string }> = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-ledger-"));
  const db = new DatabaseSync(path.join(root, "memory.sqlite"));
  initializeSchema(db, "database-test");
  db.exec("BEGIN IMMEDIATE");
  const key = randomBytes(32);
  fixtures.push({ db, root });
  return { db, key, root, ledger: new TranscriptLedger(db, key) };
}

function successCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  throw new Error("expected the operation to fail");
}

function createPending(ledger: TranscriptLedger, id: string, operationId = "operation-1", generation = 1) {
  ledger.reserve(SCOPE, owner, id, operationId, generation, null);
  return ledger.head(SCOPE, owner, id)!;
}

function createReady(ledger: TranscriptLedger, id: string, values: { incarnation?: string; contentRevision?: number; throughSeq?: number; digest?: string } = {}) {
  const head = createPending(ledger, id);
  const ref = ledger.publish(SCOPE, owner, id, head.operationId!, {
    incarnation: values.incarnation ?? "incarnation-a",
    contentRevision: values.contentRevision ?? 1,
    throughSeq: values.throughSeq ?? 1,
    digest: values.digest ?? digest("a"),
    sourceRefs: [],
  });
  return { head: ledger.head(SCOPE, owner, id)!, ref };
}

afterEach(() => {
  for (const { db, root } of fixtures.splice(0)) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("head", () => {
  it("returns null for an unknown id", () => {
    const { ledger } = fixture();
    expect(ledger.head(SCOPE, owner, "missing")).toBeNull();
  });

  it("rejects a row of another kind", () => {
    const { db, ledger } = fixture();
    db.prepare("INSERT INTO context_records VALUES(?,?,'snapshot',1,?)").run("other", SCOPE, Buffer.from([1]));
    expect(successCode(() => ledger.head(SCOPE, owner, "other"))).toBe("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
  });

  it.each(["actorKey", "providerId", "sessionId"] as const)("rejects a head whose %s belongs to another owner", field => {
    const { ledger } = fixture();
    createReady(ledger, "head-1");
    expect(successCode(() => ledger.head(SCOPE, { ...owner, [field]: "someone-else" }, "head-1"))).toBe(
      "MEMORY_CONTEXT_TRANSCRIPT_DENIED",
    );
  });

  it("returns the saved head with its owner binding", () => {
    const { ledger } = fixture();
    const created = createPending(ledger, "head-1", "operation-x", 4);
    expect(created).toMatchObject({
      id: "head-1",
      actorKey: owner.actorKey,
      providerId: owner.providerId,
      sessionId: owner.sessionId,
      bootId: owner.bootId,
      generation: 4,
      state: "pending",
      operationId: "operation-x",
      ref: null,
      incarnation: null,
      contentRevision: 0,
      throughSeq: 0,
      sourceRefs: [],
      retired: [],
    });
  });
});

describe("reserve", () => {
  it("requires an open transaction", () => {
    const { db, ledger } = fixture();
    db.exec("COMMIT");
    expect(successCode(() => ledger.reserve(SCOPE, owner, "head-1", "operation-1", 1, null))).toBe(
      "MEMORY_TRANSACTION_REQUIRED",
    );
  });

  it("keeps an existing ready head's generation and ref while switching to pending", () => {
    const { ledger } = fixture();
    const first = createPending(ledger, "head-1", "operation-1", 3);
    const published = ledger.publish(SCOPE, owner, "head-1", first.operationId!, {
      incarnation: "incarnation-a",
      contentRevision: 2,
      throughSeq: 7,
      digest: digest("a"),
      sourceRefs: [],
    });
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 99, published);
    const head = ledger.head(SCOPE, owner, "head-1")!;
    expect(head).toMatchObject({ state: "pending", operationId: "operation-2", generation: 3, ref: published });
  });

  it("refuses an expected ref when no head exists", () => {
    const { ledger } = fixture();
    expect(
      successCode(() =>
        ledger.reserve(SCOPE, owner, "head-1", "operation-1", 1, { headId: "head-1", revision: 1, digest: digest("a") }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
  });

  it("invokes the transaction fault hook after saving the record", () => {
    const { db, key } = fixture();
    const fault = vi.fn();
    const ledger = new TranscriptLedger(db, key, fault);
    ledger.reserve(SCOPE, owner, "head-1", "operation-1", 1, null);
    expect(fault).toHaveBeenCalledWith("after-record");
  });
});

describe("publish", () => {
  it("refuses to publish an unreserved id", () => {
    const { ledger } = fixture();
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-1", {
          incarnation: "incarnation-a",
          contentRevision: 1,
          throughSeq: 1,
          digest: digest("a"),
          sourceRefs: [],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_OPERATION_CONFLICT");
  });

  it("refuses a mismatched operation id", () => {
    const { ledger } = fixture();
    createPending(ledger, "head-1", "operation-1");
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-2", {
          incarnation: "incarnation-a",
          contentRevision: 1,
          throughSeq: 1,
          digest: digest("a"),
          sourceRefs: [],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_OPERATION_CONFLICT");
  });

  it("refuses to publish again after the head became ready", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-1", {
          incarnation: "incarnation-a",
          contentRevision: 1,
          throughSeq: 1,
          digest: ref.digest,
          sourceRefs: [],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_OPERATION_CONFLICT");
  });

  it("publishes the first revision and clears the operation", () => {
    const { ledger } = fixture();
    const pending = createPending(ledger, "head-1", "operation-1", 5);
    const ref = ledger.publish(SCOPE, owner, "head-1", pending.operationId!, {
      incarnation: "incarnation-a",
      contentRevision: 2,
      throughSeq: 3,
      digest: digest("a"),
      sourceRefs: [],
    });
    expect(ref).toEqual({ headId: "head-1", revision: 1, digest: digest("a") });
    expect(ledger.head(SCOPE, owner, "head-1")).toMatchObject({
      state: "ready",
      operationId: null,
      incarnation: "incarnation-a",
      contentRevision: 2,
      throughSeq: 3,
      ref,
      retired: [],
      generation: 5,
    });
  });

  it("keeps the revision when the same incarnation, revision and digest are republished", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 1, ref);
    const again = ledger.publish(SCOPE, owner, "head-1", "operation-2", {
      incarnation: "incarnation-a",
      contentRevision: 1,
      throughSeq: 1,
      digest: ref.digest,
      sourceRefs: [],
    });
    expect(again).toEqual(ref);
  });

  it("advances the revision for a new content revision in the same incarnation", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 1, ref);
    const next = ledger.publish(SCOPE, owner, "head-1", "operation-2", {
      incarnation: "incarnation-a",
      contentRevision: 2,
      throughSeq: 2,
      digest: digest("b"),
      sourceRefs: [],
    });
    expect(next).toEqual({ headId: "head-1", revision: 2, digest: digest("b") });
    expect(ledger.head(SCOPE, owner, "head-1")).toMatchObject({ retired: [], state: "ready" });
  });

  it("rejects a digest change without a content revision change", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 1, ref);
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-2", {
          incarnation: "incarnation-a",
          contentRevision: 1,
          throughSeq: 1,
          digest: digest("b"),
          sourceRefs: [],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_VERSION_MISMATCH");
  });

  it.each([
    { contentRevision: 0, throughSeq: 1 },
    { contentRevision: 1, throughSeq: 0 },
  ])("rejects a backwards revision %o in the same incarnation", values => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 1, ref);
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-2", {
          incarnation: "incarnation-a",
          digest: digest("b"),
          sourceRefs: [],
          ...values,
        }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  });

  it("retires the previous incarnation and refuses to reuse it", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1", { incarnation: "incarnation-a", contentRevision: 1 });
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 1, ref);
    const second = ledger.publish(SCOPE, owner, "head-1", "operation-2", {
      incarnation: "incarnation-b",
      contentRevision: 1,
      throughSeq: 1,
      digest: digest("b"),
      sourceRefs: [],
    });
    expect(second.revision).toBe(2);
    expect(ledger.head(SCOPE, owner, "head-1")).toMatchObject({ incarnation: "incarnation-b", retired: ["incarnation-a"] });
    ledger.reserve(SCOPE, owner, "head-1", "operation-3", 1, second);
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-3", {
          incarnation: "incarnation-a",
          contentRevision: 9,
          throughSeq: 9,
          digest: digest("c"),
          sourceRefs: [],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_REUSED");
  });

  it("refuses to exceed the retired-incarnation ceiling", () => {
    const { db, key, ledger } = fixture();
    const head: TranscriptHead = {
      ...owner,
      id: "head-1",
      generation: 1,
      state: "pending",
      operationId: "operation-1",
      ref: null,
      incarnation: "incarnation-a",
      contentRevision: 1,
      throughSeq: 1,
      sourceRefs: [],
      retired: Array.from({ length: 1001 }, (_, index) => `retired-${index}`),
    };
    db.prepare("INSERT INTO context_records VALUES(?,?,'transcript',1,?)").run(
      "head-1",
      SCOPE,
      new RecordCodec(key).seal("context-transcript", SCOPE, "head-1", head),
    );
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", "operation-1", {
          incarnation: "incarnation-b",
          contentRevision: 1,
          throughSeq: 1,
          digest: digest("b"),
          sourceRefs: [],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_INPUT_INVALID");
  });

  it("stores valid provenance with subject keys and a default suppression generation", () => {
    const { ledger } = fixture();
    const pending = createPending(ledger, "head-1", "operation-1", 7);
    const ref = ledger.publish(SCOPE, owner, "head-1", pending.operationId!, {
      incarnation: "incarnation-a",
      contentRevision: 1,
      throughSeq: 4,
      digest: digest("a"),
      sourceRefs: [],
      provenance: [
        {
          entryId: "entry-1",
          seq: 1,
          occurredAt: 1000,
          role: "user",
          turnId: "turn-1",
          subjectKeys: [`actor-attribute-${"a".repeat(64)}`],
        },
      ],
    });
    expect(ref.revision).toBe(1);
    expect(ledger.head(SCOPE, owner, "head-1")).toMatchObject({
      generation: 0,
      provenance: [
        {
          entryId: "entry-1",
          seq: 1,
          occurredAt: 1000,
          role: "user",
          turnId: "turn-1",
          suppressionGeneration: 0,
          subjectKeys: [`actor-attribute-${"a".repeat(64)}`],
        },
      ],
    });
  });

  it("preserves the previous suppression generation for the same user turn", () => {
    const { db, key, ledger } = fixture();
    new Suppression(db, key).advance(SCOPE);
    new Suppression(db, key).advance(SCOPE);
    const pending = createPending(ledger, "head-1", "operation-1", 1);
    const ref = ledger.publish(SCOPE, owner, "head-1", pending.operationId!, {
      incarnation: "incarnation-a",
      contentRevision: 1,
      throughSeq: 1,
      digest: digest("a"),
      sourceRefs: [],
      provenance: [
        {
          entryId: "entry-1",
          turnId: "turn-1",
          seq: 1,
          occurredAt: 1,
          role: "user",
          suppressionGeneration: 2,
          subjectKeys: null,
        },
      ],
    });
    ledger.reserve(SCOPE, owner, "head-1", "operation-2", 1, ref);
    ledger.publish(SCOPE, owner, "head-1", "operation-2", {
      incarnation: "incarnation-a",
      contentRevision: 1,
      throughSeq: 1,
      digest: digest("a"),
      sourceRefs: [],
      provenance: [{ entryId: "entry-1", turnId: "turn-1", seq: 1, occurredAt: 1, role: "user", subjectKeys: null }],
    });
    expect(ledger.head(SCOPE, owner, "head-1")!.provenance).toEqual([
      { entryId: "entry-1", turnId: "turn-1", seq: 1, occurredAt: 1, role: "user", suppressionGeneration: 2, subjectKeys: null },
    ]);
  });

  it("rejects a suppression generation from the future", () => {
    const { ledger } = fixture();
    const pending = createPending(ledger, "head-1", "operation-1", 1);
    expect(
      successCode(() =>
        ledger.publish(SCOPE, owner, "head-1", pending.operationId!, {
          incarnation: "incarnation-a",
          contentRevision: 1,
          throughSeq: 1,
          digest: digest("a"),
          sourceRefs: [],
          provenance: [
            { entryId: "entry-1", seq: 1, occurredAt: 1, role: "user", subjectKeys: null, suppressionGeneration: 1 },
          ],
        }),
      ),
    ).toBe("MEMORY_CONTEXT_INPUT_INVALID");
  });

  it("accepts an explicitly empty provenance array and resets the generation", () => {
    const { ledger } = fixture();
    const pending = createPending(ledger, "head-1", "operation-1", 9);
    ledger.publish(SCOPE, owner, "head-1", pending.operationId!, {
      incarnation: "incarnation-a",
      contentRevision: 1,
      throughSeq: 1,
      digest: digest("a"),
      sourceRefs: [],
      provenance: [],
    });
    expect(ledger.head(SCOPE, owner, "head-1")).toMatchObject({ provenance: [], generation: 0 });
  });

  it.each([
    ["not an array", {}],
    ["a non user-role entry", [{ entryId: "entry-1", seq: 1, occurredAt: 1, role: "robot", subjectKeys: null }]],
    ["a zero sequence", [{ entryId: "entry-1", seq: 0, occurredAt: 1, role: "user", subjectKeys: null }]],
    [
      "an unknown entry field",
      [{ entryId: "entry-1", seq: 1, occurredAt: 1, role: "user", subjectKeys: null, extra: true }],
    ],
    [
      "an entry without subjectKeys",
      [{ entryId: "entry-1", seq: 1, occurredAt: 1, role: "user" }],
    ],
    [
      "an invalid subject key",
      [{ entryId: "entry-1", seq: 1, occurredAt: 1, role: "user", subjectKeys: ["not-an-actor-attribute"] }],
    ],
    [
      "too many subject keys",
      [
        {
          entryId: "entry-1",
          seq: 1,
          occurredAt: 1,
          role: "user",
          subjectKeys: Array.from({ length: 65 }, () => `actor-attribute-${"a".repeat(64)}`),
        },
      ],
    ],
  ])("rejects provenance that is %s", (_label, provenance) => {
    const { ledger } = fixture();
    const pending = createPending(ledger, "head-1", "operation-1", 1);
    const code = successCode(() =>
      ledger.publish(SCOPE, owner, "head-1", pending.operationId!, {
        incarnation: "incarnation-a",
        contentRevision: 1,
        throughSeq: 1,
        digest: digest("a"),
        sourceRefs: [],
        provenance,
      }),
    );
    expect(["MEMORY_CONTEXT_INPUT_INVALID", "MEMORY_INPUT_INVALID"]).toContain(code);
  });
});

describe("current", () => {
  it("rejects a pending head", () => {
    const { ledger } = fixture();
    createPending(ledger, "head-1");
    expect(
      successCode(() => ledger.current(SCOPE, owner, { headId: "head-1", revision: 1, digest: digest("a") })),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_PENDING");
  });

  it("rejects a deleted head", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    ledger.remove(SCOPE, owner, ref);
    expect(successCode(() => ledger.current(SCOPE, owner, ref))).toBe("MEMORY_CONTEXT_TRANSCRIPT_DELETED");
  });

  it("rejects a stale revision or digest", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    expect(successCode(() => ledger.current(SCOPE, owner, { ...ref, revision: ref.revision + 1 }))).toBe(
      "MEMORY_CONTEXT_TRANSCRIPT_STALE",
    );
    expect(successCode(() => ledger.current(SCOPE, owner, { ...ref, digest: digest("b") }))).toBe(
      "MEMORY_CONTEXT_TRANSCRIPT_STALE",
    );
  });

  it("accepts an equal ref with a different key order and returns the head", () => {
    const { ledger } = fixture();
    const { ref, head } = createReady(ledger, "head-1");
    const reordered = { digest: ref.digest, revision: ref.revision, headId: ref.headId };
    expect(ledger.current(SCOPE, owner, reordered)).toEqual(head);
  });

  it("rejects a missing head", () => {
    const { ledger } = fixture();
    expect(
      successCode(() => ledger.current(SCOPE, owner, { headId: "missing", revision: 1, digest: digest("a") })),
    ).toBe("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
  });
});

describe("remove", () => {
  it("requires an open transaction", () => {
    const { db, ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    db.exec("COMMIT");
    expect(successCode(() => ledger.remove(SCOPE, owner, ref))).toBe("MEMORY_TRANSACTION_REQUIRED");
  });

  it("marks a ready head deleted and retires its incarnation", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1", { incarnation: "incarnation-a" });
    ledger.remove(SCOPE, owner, ref);
    expect(ledger.head(SCOPE, owner, "head-1")).toMatchObject({
      state: "deleted",
      retired: ["incarnation-a"],
      ref,
    });
    expect(successCode(() => ledger.remove(SCOPE, owner, ref))).toBe("MEMORY_CONTEXT_TRANSCRIPT_DELETED");
  });

  it("rejects removal through a stale ref", () => {
    const { ledger } = fixture();
    const { ref } = createReady(ledger, "head-1");
    expect(successCode(() => ledger.remove(SCOPE, owner, { ...ref, digest: digest("b") }))).toBe(
      "MEMORY_CONTEXT_TRANSCRIPT_STALE",
    );
  });
});
