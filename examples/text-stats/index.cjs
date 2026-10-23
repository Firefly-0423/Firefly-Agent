"use strict";

// Pure computation through the public Plugin API v1. No runtime SDK dependency.
const TOOL_ID = "text-stats_count";
let activeContext;

module.exports = {
  register(ctx) {
    if (activeContext) throw new Error("Text stats is already registered");
    ctx.registerTool({
      id: TOOL_ID,
      name: "文本统计",
      description: "统计给定文本的 Unicode 码点字符数、按空白分隔的词数和非空行数。字符数包含空白和换行；连续中文不做词语切分。全部离线处理，不保存原文。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "要统计的完整文本，可为空字符串" } },
        required: ["text"],
      },
      async execute(args) {
        if (!args || typeof args.text !== "string") throw new TypeError("text must be a string");
        const text = args.text;
        let characters = 0;
        for (const _character of text) characters++;
        let words = 0;
        for (const _word of text.matchAll(/\S+/gu)) words++;
        const nonEmptyLines = text.split(/\r\n|[\n\r\u2028\u2029]/u)
          .filter(line => line.trim().length > 0).length;
        return JSON.stringify({ characters, words, nonEmptyLines });
      },
    });
    activeContext = ctx;
  },
  unregister() {
    if (!activeContext) return;
    const ctx = activeContext;
    activeContext = undefined;
    ctx.unregisterTool(TOOL_ID);
  },
};
