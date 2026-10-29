import { describe, expect, it } from "vitest";
import { splitChatSegments } from "./chat-segments";

describe("splitChatSegments", () => {
  it("gives each paragraph its own bubble", () => {
    expect(splitChatSegments("《Weightless》吧，Marconi Union 的那首。\n\n写代码累的往往不是手。\n\n今天写的是哪部分？"))
      .toEqual(["《Weightless》吧，Marconi Union 的那首。", "写代码累的往往不是手。", "今天写的是哪部分？"]);
  });

  it("leaves a one-paragraph reply whole, line breaks included", () => {
    expect(splitChatSegments("早呀，开拓者～\n今天也要加油。")).toEqual(["早呀，开拓者～\n今天也要加油。"]);
    expect(splitChatSegments("  \n\n嗯。\n\n ")).toEqual(["嗯。"]);
    expect(splitChatSegments("")).toEqual([]);
  });

  it("never cuts inside a code fence, even across blank lines or while it is still streaming", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitChatSegments(`看这段：\n\n${code}\n\n就这样。`)).toEqual([`看这段：\n\n${code}`, "就这样。"]);
    expect(splitChatSegments("先说结论。\n\n```py\nprint(1)\n\nprint(2)")).toEqual(["先说结论。", "```py\nprint(1)\n\nprint(2)"]);
  });

  it("keeps a display formula whole when its first line already holds formula text", () => {
    expect(splitChatSegments("推导如下：\n\n$$x = 1\n\n+ 2\n$$\n\n就这样。")).toEqual(["推导如下：\n\n$$x = 1\n\n+ 2\n$$", "就这样。"]);
    expect(splitChatSegments("$$a + b$$\n\n下一段。")).toEqual(["$$a + b$$", "下一段。"]);
  });

  it("holds the blank lines of a fence that opens directly under a paragraph", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitChatSegments(`改成这样：\n${code}\n\n好了。`)).toEqual([`改成这样：\n${code}`, "好了。"]);
  });

  it("keeps a reply with reference or footnote definitions in one bubble, so its links still resolve", () => {
    const reply = "看这份[指南][guide]。\n\n还有别的问题吗？\n\n[guide]: https://docs.invalid";
    expect(splitChatSegments(reply)).toEqual([reply]);
    expect(splitChatSegments("结论[^1]。\n\n再补一句。\n\n[^1]: 出处")).toHaveLength(1);
  });

  it("keeps the indentation of a reply that opens with an indented code block", () => {
    expect(splitChatSegments("\n    const a = 1;\n    const b = 2;\n\n这样就行。")).toEqual(["    const a = 1;\n    const b = 2;", "这样就行。"]);
  });

  it("keeps a list or a table together and attaches the sentence that introduces it", () => {
    const list = "- 第一项\n\n- 第二项\n\n  继续说第二项\n\n- 第三项";
    expect(splitChatSegments(`好的。\n\n可以这样排：\n\n${list}\n\n有问题再叫我。`))
      .toEqual(["好的。", `可以这样排：\n\n${list}`, "有问题再叫我。"]);
    const table = "| 工具 | 作用 |\n| --- | --- |\n| cargo | 构建 |";
    expect(splitChatSegments(`对比一下：\n\n${table}`)).toEqual([`对比一下：\n\n${table}`]);
  });

  it("joins a heading to what follows it", () => {
    expect(splitChatSegments("开头。\n\n## 小结\n\n今天就到这里。")).toEqual(["开头。", "## 小结\n\n今天就到这里。"]);
  });

  it("folds a fragment too short to stand alone into the bubble before it", () => {
    expect(splitChatSegments("这首歌很安静。\n\n嗯。\n\n你会喜欢的。")).toEqual(["这首歌很安静。\n\n嗯。", "你会喜欢的。"]);
  });

  it("stops at six bubbles, keeping the rest in the last one", () => {
    const parts = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段，说点什么。`);
    const segments = splitChatSegments(parts.join("\n\n"));
    expect(segments).toHaveLength(6);
    expect(segments.slice(0, 5)).toEqual(parts.slice(0, 5));
    expect(segments[5]).toBe(parts.slice(5).join("\n\n"));
  });

  it("keeps earlier bubbles unchanged as more of the reply streams in", () => {
    const full = "第一段话。\n\n第二段话。\n\n第三段话，还在写";
    const early = splitChatSegments(full.slice(0, full.indexOf("第三")));
    const later = splitChatSegments(full);
    expect(later.slice(0, early.length)).toEqual(early);
  });
});
