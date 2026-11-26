// Pure computation through the Firefly plugin API 1.2. No runtime SDK dependency.
const TOOL_ID = "text-stats_count";
const disposables = [];

/** Runs a pure handler and maps its outcome onto a tool result: bad arguments are reported as not executed. */
function offline(handler) {
  return async (args) => {
    try {
      return { status: "succeeded", output: await handler(args) };
    } catch (error) {
      return { status: "not_executed", reason: error instanceof Error ? error.message : String(error) };
    }
  };
}

export default {
  activate(ctx) {
    disposables.push(ctx.tools.register({
      name: TOOL_ID,
      description: "统计给定文本的 Unicode 码点字符数、按空白分隔的词数和非空行数。字符数包含空白和换行；连续中文不做词语切分。全部离线处理，不保存原文。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要统计的完整文本，可为空字符串" } },
        required: ["text"],
      },
      execute: offline((args) => {
        if (!args || typeof args.text !== "string") throw new TypeError("text must be a string");
        const text = args.text;
        let characters = 0;
        for (const _character of text) characters++;
        let words = 0;
        for (const _word of text.matchAll(/\S+/gu)) words++;
        const nonEmptyLines = text.split(/\r\n|[\n\r\u2028\u2029]/u)
          .filter(line => line.trim().length > 0).length;
        return ({ characters, words, nonEmptyLines });
      }),
    }));
  },
  deactivate() {
    while (disposables.length > 0) disposables.pop().dispose();
  },
};
