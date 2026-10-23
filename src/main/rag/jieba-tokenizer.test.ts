import { expect, it, vi } from "vitest";
import { tokenizeJieba } from "./jieba-tokenizer";
const plain = (word: string, tag = "eng", isStop = false, isNoun = false) => ({ word, tag, isStop, isNoun });
it("lowercases English and numbers, ignoring whitespace without calling jieba", () => {
  const jieba = { cut: vi.fn(), tag: vi.fn() };
  expect(tokenizeJieba("  HELLO\tWorld 123\n", jieba, new Set())).toEqual([plain("hello"), plain("world"), plain("123")]);
  expect(jieba.cut).not.toHaveBeenCalled();
  expect(tokenizeJieba("   ", jieba, new Set())).toEqual([]);
});
it("merges the longest custom word and keeps unmatched cuts in order", () => {
  const jieba = { cut: () => ["流", "萤", "小", "助", "手", "的", "ABC"], tag: (word: string) => [{ word, tag: word === "的" ? "u" : "nr" }] };
  expect(tokenizeJieba("流萤小助手的ABC", jieba, new Set(["流萤", "流萤小助手", "不足够长"]))).toEqual([plain("流萤小助手", "nr", false, true), plain("的", "u", true), plain("abc", "nr", false, true)]);
});
it.each(["n", "nr", "ns", "nt", "nz", "ng", "vn", "an"])("marks %s as noun", tag => {
  expect(tokenizeJieba("猫", { cut: () => ["猫"], tag: () => [{ word: "猫", tag }] }, new Set())[0]).toEqual(plain("猫", tag, false, true));
});
it("uses word/tag stop lists and a missing-tag fallback", () => {
  const jieba = { cut: () => ["我", "非常", "未知"], tag: (word: string) => word === "未知" ? [] : [{ word, tag: word === "非常" ? "d" : "x" }] };
  expect(tokenizeJieba("我非常未知", jieba, new Set())).toEqual([plain("我", "x", true), plain("非常", "d", true), plain("未知", "x")]);
});
it.each(["cut", "tag"])("falls back to individual Chinese characters when %s fails", failure => {
  const jieba = { cut: () => { if (failure === "cut") throw Error("failed"); return ["猫"]; }, tag: () => { throw Error("failed"); } };
  expect(tokenizeJieba("我猫ABC12", jieba, new Set())).toEqual([plain("我", "x", true), plain("猫", "x"), plain("abc"), plain("12")]);
});
it("handles empty text", () => { expect(tokenizeJieba("", { cut: () => [], tag: () => [] }, new Set())).toEqual([]); });
