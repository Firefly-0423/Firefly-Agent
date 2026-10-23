import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ file: "" }));
vi.mock("../storage-context", () => ({ getStorageContext: () => ({ files: { skillDescriptionsZh: storage.file } }) }));

import { cachedZh, cachedZhMap, isChinese, parseTranslation, translateMissing, translationMessages } from "./skill-description-zh";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-zh-")); storage.file = path.join(dir, "skill-descriptions-zh.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const skill = (id: string, description: string) => ({ id, description });

describe("skill description translation", () => {
  it("translates only what is missing, saves it, and does not ask again", async () => {
    const translate = vi.fn(async (batch: readonly { id: string }[]) => Object.fromEntries(batch.map(item => [item.id, `中文：${item.id}`])));
    const skills = [skill("code-review", "Reviews code."), skill("writing", "Writes docs."), skill("zh-already", "已经是中文的说明")];
    expect(await translateMissing(skills, translate)).toEqual({ "code-review": "中文：code-review", writing: "中文：writing", "zh-already": "已经是中文的说明" });
    expect(translate).toHaveBeenCalledOnce();
    expect(translate.mock.calls[0]![0].map(item => item.id)).toEqual(["code-review", "writing"]);
    await translateMissing(skills, translate);
    expect(translate).toHaveBeenCalledOnce();
    expect(cachedZhMap(skills)["code-review"]).toBe("中文：code-review");
  });

  it("treats a changed English description as untranslated", async () => {
    await translateMissing([skill("a", "Old text.")], async () => ({ a: "旧" }));
    expect(cachedZh("a", "Old text.")).toBe("旧");
    expect(cachedZh("a", "New text.")).toBeUndefined();
  });

  it("keeps the batches that worked when a later one fails", async () => {
    const skills = Array.from({ length: 15 }, (_, index) => skill(`s${index}`, `Skill ${index}.`));
    let calls = 0;
    await expect(translateMissing(skills, async (batch) => {
      calls += 1;
      if (calls === 2) throw new Error("model down");
      return Object.fromEntries(batch.map(item => [item.id, "好"]));
    })).rejects.toThrow("model down");
    expect(Object.keys(cachedZhMap(skills))).toHaveLength(12);
  });

  it("shares one run between overlapping requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const translate = vi.fn(async (batch: readonly { id: string }[]) => { await gate; return Object.fromEntries(batch.map(item => [item.id, "好"])); });
    const first = translateMissing([skill("a", "A.")], translate);
    const second = translateMissing([skill("a", "A.")], translate);
    release();
    await Promise.all([first, second]);
    expect(translate).toHaveBeenCalledOnce();
  });

  it("gives a skill added during a running translation its own pass afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: string[][] = [];
    const translate = async (batch: readonly { id: string }[]) => { seen.push(batch.map(item => item.id)); await gate; return Object.fromEntries(batch.map(item => [item.id, "好"])); };
    const first = translateMissing([skill("a", "A.")], translate);
    const second = translateMissing([skill("a", "A."), skill("b", "B.")], translate);
    release();
    expect(await second).toEqual({ a: "好", b: "好" });
    await first;
    expect(seen).toEqual([["a"], ["b"]]);
  });

  it("refuses ids that could poison the cache", async () => {
    const translate = vi.fn(async () => ({}));
    await translateMissing([skill("__proto__", "Bad.")], translate);
    expect(translate).not.toHaveBeenCalled();
  });

  it("reads the model's JSON answer, ignoring extra text and unasked keys", () => {
    const batch = [skill("a", "A."), skill("b", "B.")];
    expect(parseTranslation('好的：\n{"a":"甲","b":"  乙 ","c":"丙"}\n', batch)).toEqual({ a: "甲", b: "乙" });
    expect(parseTranslation("no json", batch)).toEqual({});
    expect(translationMessages(batch)[1]!.content).toBe('{"a":"A.","b":"B."}');
  });

  it("recognises text that is already Chinese", () => {
    expect(isChinese("用于审查代码 code review")).toBe(true);
    expect(isChinese("Reviews code before merge.")).toBe(false);
  });
});
