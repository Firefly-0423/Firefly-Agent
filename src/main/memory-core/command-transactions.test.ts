import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTransaction } from "./command-transactions";
import { canonicalJson } from "./repository-types";
import { transactionNow } from "./transaction-clock";

const KEY = Buffer.alloc(32, 7);
const databases: DatabaseSync[] = [];

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, request_digest BLOB NOT NULL, result BLOB NOT NULL)");
  db.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  return db;
}

function receipt(db: DatabaseSync): { scope_key?: unknown; request_digest?: Uint8Array; result?: Uint8Array } | undefined {
  return db.prepare("SELECT scope_key, request_digest, result FROM command_receipts").get() as
    | { scope_key?: unknown; request_digest?: Uint8Array; result?: Uint8Array }
    | undefined;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("executeTransaction", () => {
  it("rejects an invalid scope or command id before opening a transaction", () => {
    const db = fixture();
    for (const input of [
      { scope: "", commandId: "command-1" },
      { scope: "bad scope", commandId: "command-1" },
      { scope: "scope-a", commandId: "" },
      { scope: "scope-a", commandId: "bad/command" },
      { scope: "x".repeat(97), commandId: "command-1" },
    ]) {
      const apply = vi.fn();
      expect(() =>
        executeTransaction({ db, key: KEY, request: {}, apply, ...input }),
      ).toThrow("MEMORY_INPUT_INVALID");
      expect(apply).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(false);
    }
    expect(receipt(db)).toBeUndefined();
  });

  it("rejects a non-canonical request before applying anything", () => {
    const db = fixture();
    for (const request of [undefined, new Date(0), [1, , 3], { value: Number.NaN }]) {
      const apply = vi.fn();
      expect(() =>
        executeTransaction({ db, key: KEY, scope: "scope-a", commandId: "command-1", request, apply }),
      ).toThrow("MEMORY_INPUT_INVALID");
      expect(apply).not.toHaveBeenCalled();
    }
    expect(receipt(db)).toBeUndefined();
    expect(db.isTransaction).toBe(false);
  });

  it("rejects a request whose canonical JSON exceeds 8 MiB", () => {
    const db = fixture();
    const apply = vi.fn();
    expect(() =>
      executeTransaction({
        db,
        key: KEY,
        scope: "scope-a",
        commandId: "command-1",
        request: "x".repeat(8 * 1024 * 1024),
        apply,
      }),
    ).toThrow("MEMORY_INPUT_INVALID");
    expect(apply).not.toHaveBeenCalled();
    expect(receipt(db)).toBeUndefined();
  });

  it("applies once, stores an encrypted result and a keyed digest", () => {
    const db = fixture();
    const request = { kind: "write", body: { text: "secret-value", count: 2 } };
    const apply = vi.fn(() => {
      db.prepare("INSERT INTO effects VALUES (1, 'created')").run();
      return { ok: true, text: "secret-value" };
    });

    const result = executeTransaction({
      db,
      key: KEY,
      scope: "scope-a",
      commandId: "command-1",
      request,
      apply,
    });

    expect(result).toEqual({ ok: true, text: "secret-value" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) n FROM effects").get()?.n).toBe(1);

    const stored = receipt(db);
    expect(stored?.scope_key).toBe("scope-a");
    expect(stored?.request_digest).toBeInstanceOf(Uint8Array);
    expect(stored?.result).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(stored!.result!).includes(Buffer.from("secret-value"))).toBe(false);
    expect(Buffer.from(stored!.request_digest!)).not.toEqual(
      createHash("sha256").update(canonicalJson(request)).digest(),
    );
    expect(db.isTransaction).toBe(false);
  });

  it("replays an identical command without re-applying it and returns the stored result", () => {
    const db = fixture();
    const apply = vi.fn(() => ({ answer: 42 }));
    const input = { db, key: KEY, scope: "scope-a", commandId: "command-1", request: { q: "life" }, apply };

    const first = executeTransaction(input);
    const second = executeTransaction(input);

    expect(first).toEqual({ answer: 42 });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) n FROM command_receipts").get()?.n).toBe(1);
  });

  it("refuses a changed request under the same command id", () => {
    const db = fixture();
    const apply = vi.fn(() => ({ ok: true }));
    executeTransaction({ db, key: KEY, scope: "scope-a", commandId: "command-1", request: { value: 1 }, apply });

    expect(() =>
      executeTransaction({ db, key: KEY, scope: "scope-a", commandId: "command-1", request: { value: 2 }, apply }),
    ).toThrow("MEMORY_COMMAND_CONFLICT");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("refuses a changed scope under the same command id", () => {
    const db = fixture();
    const apply = vi.fn(() => ({ ok: true }));
    executeTransaction({ db, key: KEY, scope: "scope-a", commandId: "shared", request: {}, apply });

    expect(() =>
      executeTransaction({ db, key: KEY, scope: "scope-b", commandId: "shared", request: {}, apply }),
    ).toThrow("MEMORY_COMMAND_CONFLICT");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("rolls back applied records and the receipt when the fault hook throws", () => {
    const db = fixture();
    const input = {
      db,
      key: KEY,
      scope: "scope-a",
      commandId: "command-1",
      request: { value: 1 },
      apply: () => {
        db.prepare("INSERT INTO effects VALUES (1, 'created')").run();
        return { ok: true };
      },
      fault: (stage: "after-record" | "before-receipt") => {
        if (stage === "before-receipt") throw new Error("INJECTED_FAULT");
      },
    };

    expect(() => executeTransaction(input)).toThrow("INJECTED_FAULT");
    expect(db.prepare("SELECT count(*) n FROM effects").get()?.n).toBe(0);
    expect(receipt(db)).toBeUndefined();
    expect(db.isTransaction).toBe(false);

    const retry = executeTransaction({ ...input, fault: undefined });
    expect(retry).toEqual({ ok: true });
    expect(db.prepare("SELECT count(*) n FROM effects").get()?.n).toBe(1);
  });

  it("rolls back when apply throws and can be retried", () => {
    const db = fixture();
    const failing = {
      db,
      key: KEY,
      scope: "scope-a",
      commandId: "command-1",
      request: {},
      apply: () => {
        db.prepare("INSERT INTO effects VALUES (1, 'dirty')").run();
        throw new Error("APPLY_FAILED");
      },
    };

    expect(() => executeTransaction(failing)).toThrow("APPLY_FAILED");
    expect(db.prepare("SELECT count(*) n FROM effects").get()?.n).toBe(0);
    expect(receipt(db)).toBeUndefined();
    expect(db.isTransaction).toBe(false);

    expect(
      executeTransaction({
        ...failing,
        apply: () => {
          db.prepare("INSERT INTO effects VALUES (1, 'clean')").run();
          return { retried: true };
        },
      }),
    ).toEqual({ retried: true });
  });

  it("exposes one trusted clock value inside the applied operation", () => {
    const db = fixture();
    let seen: number | undefined;
    const result = executeTransaction({
      db,
      key: KEY,
      scope: "scope-a",
      commandId: "command-1",
      request: {},
      clock: () => 1234,
      apply: () => {
        seen = transactionNow(db);
        return { seen };
      },
    });

    expect(result).toEqual({ seen: 1234 });
    expect(seen).toBe(1234);
  });

  it("rolls back when the receipt payload cannot be sealed with an invalid key", () => {
    const db = fixture();
    const apply = vi.fn(() => {
      db.prepare("INSERT INTO effects VALUES (1, 'created')").run();
      return { ok: true };
    });

    expect(() =>
      executeTransaction({
        db,
        key: Buffer.alloc(31),
        scope: "scope-a",
        commandId: "command-1",
        request: {},
        apply,
      }),
    ).toThrow("MEMORY_KEY_INVALID");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) n FROM effects").get()?.n).toBe(0);
    expect(receipt(db)).toBeUndefined();
    expect(db.isTransaction).toBe(false);
  });
});
