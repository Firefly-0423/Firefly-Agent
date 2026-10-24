import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {
 appendToSection,
 contentHash,
 extractHeadings,
 readSection,
 replaceSection,
} from "./obsidian-markdown";

const CONTENT="# A\ntext\n## B\nmore\n# C\nend";

describe("contentHash",()=>{
 it("returns the sha256 hex digest of the UTF-8 content",()=>{
  expect(contentHash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(contentHash("abc")).toBe(createHash("sha256").update("abc","utf8").digest("hex"));
  expect(contentHash("中文")).not.toBe(contentHash("abc"));
 });
});

describe("extractHeadings",()=>{
 it("extracts levels, path stacks, text and offsets",()=>{
  expect(extractHeadings(CONTENT)).toEqual([
   {level:1,depth:1,text:"A",headingText:"A",path:["A"],startOffset:0,endOffset:3},
   {level:2,depth:2,text:"B",headingText:"B",path:["A","B"],startOffset:9,endOffset:13},
   {level:1,depth:1,text:"C",headingText:"C",path:["C"],startOffset:19,endOffset:22},
  ]);
 });
 it("pops deeper headings and trims heading text",()=>{
  const headings=extractHeadings("### Deep\n# Top\n##   Spaced   ");
  expect(headings.map(h=>h.path)).toEqual([["Deep"],["Top"],["Top","Spaced"]]);
  expect(headings[2].text).toBe("Spaced");
 });
 it("ignores non-heading lines and headings without a space",()=>{
  expect(extractHeadings("text\n#NoSpace\n####### too deep\n# Yes").map(h=>h.text)).toEqual(["Yes"]);
 });
 it("returns an empty list for content without headings",()=>{
  expect(extractHeadings("plain text\n")).toEqual([]);
 });
});

describe("section operations",()=>{
 it.each([
  {path:["A"],includeChildren:false,expected:"# A\ntext"},
  {path:["A"],includeChildren:true,expected:"# A\ntext\n## B\nmore"},
  {path:["A","B"],includeChildren:false,expected:"## B\nmore"},
  {path:["A","B"],includeChildren:true,expected:"## B\nmore"},
  {path:["C"],includeChildren:false,expected:"# C\nend"},
  {path:["C"],includeChildren:true,expected:"# C\nend"},
 ])("reads $path with includeChildren=$includeChildren",({path,includeChildren,expected})=>{
  expect(readSection(CONTENT,path,includeChildren)).toBe(expected);
 });
 it.each([
  {path:["A"],includeChildren:false,replacement:"# A\nnew\n",expected:"# A\nnew\n## B\nmore\n# C\nend"},
  {path:["A"],includeChildren:true,replacement:"# A\nnew\n",expected:"# A\nnew\n# C\nend"},
  {path:["A","B"],includeChildren:true,replacement:"## B\nnew\n",expected:"# A\ntext\n## B\nnew\n# C\nend"},
  {path:["C"],includeChildren:true,replacement:"# C\nnew\n",expected:"# A\ntext\n## B\nmore\n# C\nnew\n"},
 ])("replaces $path with includeChildren=$includeChildren",({path,includeChildren,replacement,expected})=>{
  expect(replaceSection(CONTENT,path,replacement,includeChildren)).toBe(expected);
 });
 it.each([
  {path:["A"],expected:"# A\ntext\n## B\nmore\n\ntail\n# C\nend"},
  {path:["A","B"],expected:"# A\ntext\n## B\nmore\n\ntail\n# C\nend"},
  {path:["C"],expected:"# A\ntext\n## B\nmore\n# C\nend\n\ntail\n"},
 ])("appends after $path and its children, preserving following sections",({path,expected})=>{
  expect(appendToSection(CONTENT,path,"tail")).toBe(expected);
 });
});

describe("section locate errors",()=>{
 it("returns NOT_FOUND for an unknown path",()=>{
  expect(readSection(CONTENT,["Missing"],false)).toEqual({kind:"NOT_FOUND"});
  expect(readSection(CONTENT,[],false)).toEqual({kind:"NOT_FOUND"});
  expect(replaceSection(CONTENT,["Missing"],"x",false)).toEqual({kind:"NOT_FOUND"});
  expect(appendToSection(CONTENT,["Missing"],"tail")).toEqual({kind:"NOT_FOUND"});
 });
 it("returns AMBIGUOUS when the same path occurs twice",()=>{
  const content="# A\none\n# A\ntwo";
  const expected={kind:"AMBIGUOUS",matches:[{path:["A"]},{path:["A"]}]};
  expect(readSection(content,["A"],false)).toEqual(expected);
  expect(replaceSection(content,["A"],"x",false)).toEqual(expected);
  expect(appendToSection(content,["A"],"x")).toEqual(expected);
 });
});
