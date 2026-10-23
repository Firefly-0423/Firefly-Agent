import {describe,expect,it} from "vitest";
import {createVisibleStreamFilter,stripThinkBlocks} from "./chat-stream-utils";

describe("stripThinkBlocks",()=>{
 it("removes complete think blocks, including multiline and uppercase tags",()=>{
  expect(stripThinkBlocks("before<think>secret</think>after")).toBe("beforeafter");
  expect(stripThinkBlocks("a<THINK>line one\nline two</THINK>b")).toBe("ab");
 });
 it("removes an unterminated trailing think block",()=>{
  expect(stripThinkBlocks("visible<think>not shown")).toBe("visible");
  expect(stripThinkBlocks("<think>only hidden")).toBe("");
 });
 it("trims surrounding whitespace and keeps normal text intact",()=>{
  expect(stripThinkBlocks("  plain text  ")).toBe("plain text");
  expect(stripThinkBlocks("")).toBe("");
 });
});

describe("createVisibleStreamFilter",()=>{
 it("passes short plain chunks only after flush",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.push("hello")).toBe("");
  expect(filter.flush()).toBe("hello");
 });
 it("emits text before a think block and suppresses its body",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.push("visible<think>hidden</think>tail")).toBe("visible");
  expect(filter.flush()).toBe("tail");
 });
 it("handles tags split across chunk boundaries",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.push("a<thi")).toBe("");
  expect(filter.push("nk>b")).toBe("a");
  expect(filter.push("</thi")).toBe("");
  expect(filter.push("nk>c")).toBe("");
  expect(filter.flush()).toBe("c");
 });
 it("matches uppercase tags in a stream",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.push("A<THINK>secret</THINK>B")).toBe("A");
  expect(filter.flush()).toBe("B");
 });
 it("drops an unterminated think block on flush",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.push("<think>never closed")).toBe("");
  expect(filter.flush()).toBe("");
 });
 it("preserves a partial open tag that was never completed",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.push("<thin")).toBe("");
  expect(filter.flush()).toBe("<thin");
 });
 it("flush is empty for an empty stream",()=>{
  const filter=createVisibleStreamFilter();
  expect(filter.flush()).toBe("");
 });
});
