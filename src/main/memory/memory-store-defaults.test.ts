import { describe, expect, it } from "vitest";
import { getMemoryLanguage } from "../locale-context";
import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  DEFAULT_L1,
  boundMemorySnippet,
  createDefaultL0,
  createDefaultMemoryStore,
  extractMemoryKeywords,
  isCurrentMemoryStore,
} from "./memory-store-defaults";

function validStore() {
  return createDefaultMemoryStore();
}

describe("isCurrentMemoryStore", () => {
  it("accepts a freshly created store", () => {
    expect(isCurrentMemoryStore(validStore())).toBe(true);
  });

  it("rejects non-object roots and wrong schema/version fields", () => {
    for (const value of [null, undefined, [], "store", 1, true]) {
      expect(isCurrentMemoryStore(value)).toBe(false);
    }
    expect(isCurrentMemoryStore({ ...validStore(), schemaVersion: 1 })).toBe(false);
    expect(isCurrentMemoryStore({ ...validStore(), version: "1" })).toBe(false);
  });

  it("rejects missing, null or array L0/L1 profiles", () => {
    for (const field of ["l0", "l1"] as const) {
      expect(isCurrentMemoryStore({ ...validStore(), [field]: null })).toBe(false);
      expect(isCurrentMemoryStore({ ...validStore(), [field]: [] })).toBe(false);
      const missing = validStore() as unknown as Record<string, unknown>;
      delete missing[field];
      expect(isCurrentMemoryStore(missing)).toBe(false);
    }
  });

  it("validates every required string, boolean and number field", () => {
    for (const field of [
      "nickname",
      "preferredName",
      "occupation",
      "longTermInterests",
      "language",
      "permanentNote",
    ] as const) {
      const store = validStore();
      (store.l0 as unknown as Record<string, unknown>)[field] = 1;
      expect(isCurrentMemoryStore(store), field).toBe(false);
    }
    const pinned = validStore();
    (pinned.l0 as unknown as Record<string, unknown>).isPinned = "false";
    expect(isCurrentMemoryStore(pinned)).toBe(false);
    const updatedAt = validStore();
    (updatedAt.l0 as unknown as Record<string, unknown>).updatedAt = "0";
    expect(isCurrentMemoryStore(updatedAt)).toBe(false);

    for (const field of ["recentGoals", "recentPreferences", "currentProject"] as const) {
      const store = validStore();
      (store.l1 as unknown as Record<string, unknown>)[field] = 1;
      expect(isCurrentMemoryStore(store), field).toBe(false);
    }
    const generatedAt = validStore();
    (generatedAt.l1 as unknown as Record<string, unknown>).generatedAt = "0";
    expect(isCurrentMemoryStore(generatedAt)).toBe(false);
    const roundCount = validStore();
    (roundCount.l1 as unknown as Record<string, unknown>).roundCount = null;
    expect(isCurrentMemoryStore(roundCount)).toBe(false);
  });

  it("requires an L2 array whose entries carry string id and content", () => {
    expect(isCurrentMemoryStore({ ...validStore(), l2: null })).toBe(false);
    expect(isCurrentMemoryStore({ ...validStore(), l2: {} })).toBe(false);
    expect(isCurrentMemoryStore({ ...validStore(), l2: [null] })).toBe(false);
    expect(isCurrentMemoryStore({ ...validStore(), l2: [{ id: 1, content: "x" }] })).toBe(false);
    expect(isCurrentMemoryStore({ ...validStore(), l2: [{ id: "id" }] })).toBe(false);
    expect(isCurrentMemoryStore({ ...validStore(), l2: [{ id: "", content: "" }] })).toBe(true);
  });

  it("allows optional log/state arrays to be absent but not malformed", () => {
    const withoutOptional = validStore() as unknown as Record<string, unknown>;
    delete withoutOptional.evidence;
    delete withoutOptional.reflectionLogs;
    delete withoutOptional.conflictLogs;
    delete withoutOptional.l2DmaeStates;
    expect(isCurrentMemoryStore(withoutOptional)).toBe(true);

    for (const field of ["evidence", "reflectionLogs", "conflictLogs", "l2DmaeStates"] as const) {
      expect(isCurrentMemoryStore({ ...validStore(), [field]: {} }), field).toBe(false);
      expect(isCurrentMemoryStore({ ...validStore(), [field]: [] }), field).toBe(true);
    }
  });
});

describe("defaults", () => {
  it("creates L0 initialized from the current memory language", () => {
    expect(createDefaultL0()).toEqual({
      nickname: "",
      preferredName: "",
      occupation: "",
      longTermInterests: "",
      language: getMemoryLanguage(),
      permanentNote: "",
      isPinned: false,
      updatedAt: 0,
    });
  });

  it("exposes the default L1 profile", () => {
    expect(DEFAULT_L1).toEqual({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount: 0,
    });
  });

  it("creates a complete store with independent nested values per call", () => {
    const first = createDefaultMemoryStore();
    const second = createDefaultMemoryStore();

    expect(first).toMatchObject({
      schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
      version: 1,
      l2: [],
      evidence: [],
      reflectionLogs: [],
      conflictLogs: [],
      l2DmaeStates: [],
    });
    expect(first.l0).not.toBe(second.l0);
    expect(first.l1).not.toBe(second.l1);
    expect(first.l2).not.toBe(second.l2);
    first.l0.nickname = "changed";
    first.l1.roundCount = 3;
    first.l2.push({} as never);
    expect(second.l0.nickname).toBe("");
    expect(second.l1.roundCount).toBe(0);
    expect(second.l2).toEqual([]);
  });
});

describe("extractMemoryKeywords", () => {
  it("returns an empty list for missing or empty input", () => {
    expect(extractMemoryKeywords("")).toEqual([]);
    expect(extractMemoryKeywords("   ")).toEqual([]);
    expect(extractMemoryKeywords("，。！？")).toEqual([]);
  });

  it("lowercases Latin words, keeps numbers, and splits CJK characters", () => {
    expect(extractMemoryKeywords("Hello WORLD hello 123 123")).toEqual(["hello", "123", "world"]);
    expect(extractMemoryKeywords("猫猫")).toEqual(["猫"]);
    expect(extractMemoryKeywords("ひらがなカタカナ")).toEqual([
      "カ",
      "ひ",
      "ら",
      "が",
      "な",
      "タ",
      "ナ",
    ]);
  });

  it("orders by frequency and preserves first-seen order for ties", () => {
    expect(extractMemoryKeywords("我 喜欢 猫 也 喜欢 猫")).toEqual(["喜", "欢", "猫", "我", "也"]);
  });

  it("truncates to max results (default 12)", () => {
    expect(extractMemoryKeywords("a b c d e", 2)).toEqual(["a", "b"]);
    expect(extractMemoryKeywords("a b c d e f g h i j k l m")).toHaveLength(12);
    expect(extractMemoryKeywords("a b", 0)).toEqual([]);
  });
});

describe("boundMemorySnippet", () => {
  it("returns undefined for missing or empty text", () => {
    expect(boundMemorySnippet(undefined, 10)).toBeUndefined();
    expect(boundMemorySnippet("", 10)).toBeUndefined();
  });

  it("keeps text within the limit and truncates longer text", () => {
    expect(boundMemorySnippet("abc", 3)).toBe("abc");
    expect(boundMemorySnippet("abcd", 3)).toBe("abc");
    expect(boundMemorySnippet("abcd", 0)).toBe("");
    expect(boundMemorySnippet("abc", 10)).toBe("abc");
  });
});
