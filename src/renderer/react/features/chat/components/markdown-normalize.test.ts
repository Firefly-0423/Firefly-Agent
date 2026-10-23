import { expect, test } from "vitest";
import { normalizeModelMarkdown } from "./markdown-normalize";

test.each([
  ["##目录", "## 目录"], ["######末级", "###### 末级"],
  ["#######越界", "#######越界"],
  ["### 概念。解释文字", "### 概念\n\n解释文字"],
  ["### 概念。", "### 概念。"],
  ["### 概念。字", "### 概念。字"],
  ["### 示例```ts\nlet total = 8;\n```", "### 示例\n\n```ts\nlet total = 8;\n```"],
  ["说明里写```也可以", "说明里写```也可以"],
  ["内联 `#标签` 示例", "内联 `#标签` 示例"],
  ["```md\n##不可修复\n段落```ts\n```", "```md\n##不可修复\n段落```ts\n```"],
  ["## 已有标题\n\n完整段落。\n\n```ts\nlet size = 9;\n```\n\n- 第一项",
    "## 已有标题\n\n完整段落。\n\n```ts\nlet size = 9;\n```\n\n- 第一项"],
])("normalizes only unambiguous prose damage: %s", (input, output) => {
  expect(normalizeModelMarkdown(input)).toBe(output);
});

test("repairs a mixed document in one pass and reaches a fixed point", () => {
  const damaged = '引言\n\n##安装\n\n### 前置条件。**需要权限**\n\n```sh\necho "ready"\n```\n\n### 启动命令```sh\nrun\n```';
  const repaired = '引言\n\n## 安装\n\n### 前置条件\n\n**需要权限**\n\n```sh\necho "ready"\n```\n\n### 启动命令\n\n```sh\nrun\n```';
  expect(normalizeModelMarkdown(damaged)).toBe(repaired);
  expect(normalizeModelMarkdown(repaired)).toBe(repaired);
});
