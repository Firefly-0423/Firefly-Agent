// Pure computation through the public Plugin API v1; UTF-8 sizes are computed by hand, so no TextEncoder or Buffer is needed.
// The head / tail / headTail retention strategies, the UTF-8 boundary rule and the omission wording are adapted from
// deepseek-harness packages/util/output-retention (MIT, Copyright (c) 2026 DeepSeek); see LICENSE and README.md.
const TOOL_ID = "text-trim_cap";
const MAX_CHARS = 1_000_000;
const STRATEGIES = ["head", "tail", "headTail"];
const disposables = [];

function isBudget(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** UTF-8 size of one code point. A lone surrogate is encoded as U+FFFD, three bytes, exactly as TextEncoder does. */
function byteLength(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

function totalBytes(text) {
  let total = 0;
  for (const character of text) total += byteLength(character.codePointAt(0));
  return total;
}

/** Longest prefix whose UTF-8 size fits the budget without splitting a code point: returns its UTF-16 length and byte size. */
function headFit(text, budget) {
  let units = 0;
  let bytes = 0;
  for (const character of text) {
    const size = byteLength(character.codePointAt(0));
    if (bytes + size > budget) break;
    bytes += size;
    units += character.length;
  }
  return { units, bytes };
}

/** Longest suffix that fits, walking backwards over whole code points (a surrogate pair counts once). */
function tailFit(text, budget) {
  let units = 0;
  let bytes = 0;
  let end = text.length;
  while (end > 0) {
    const low = text.charCodeAt(end - 1);
    const paired = low >= 0xdc00 && low <= 0xdfff && end >= 2 && text.charCodeAt(end - 2) >= 0xd800 && text.charCodeAt(end - 2) <= 0xdbff;
    const size = paired ? 4 : byteLength(low);
    if (bytes + size > budget) break;
    bytes += size;
    units += paired ? 2 : 1;
    end -= paired ? 2 : 1;
  }
  return { units, bytes };
}

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
      description: "把长文本截断到指定的 UTF-8 字节预算，并报告确切丢弃了多少字节。strategy=head 保留开头（默认），tail 保留结尾，headTail 同时保留开头和结尾并在中间标出省略。截断位置落在完整字符边界上，不会产生乱码；预算按字节而不是字符计算。全部离线处理，不保存原文。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: `要截断的文本，最多 ${MAX_CHARS} 个字符` },
          strategy: { type: "string", enum: STRATEGIES, description: "保留方式：head（开头，默认）、tail（结尾）、headTail（两端）" },
          maxBytes: { type: "number", description: "head 或 tail 保留的最大字节数，非负整数" },
          headBytes: { type: "number", description: "仅 headTail：开头保留的最大字节数，非负整数" },
          tailBytes: { type: "number", description: "仅 headTail：结尾保留的最大字节数，非负整数" },
        },
        required: ["text"],
      },
      execute: offline((args) => {
        if (!args || typeof args.text !== "string") throw new TypeError("text must be a string");
        if (args.text.length > MAX_CHARS) throw new RangeError(`text must be at most ${MAX_CHARS} characters`);
        const strategy = args.strategy === undefined ? "head" : args.strategy;
        if (!STRATEGIES.includes(strategy)) throw new TypeError(`strategy must be one of ${STRATEGIES.join(", ")}`);
        let headBudget = 0;
        let tailBudget = 0;
        if (strategy === "headTail") {
          if (!isBudget(args.headBytes) || !isBudget(args.tailBytes)) throw new TypeError("headBytes and tailBytes must be non-negative integers");
          if (args.maxBytes !== undefined) throw new TypeError("maxBytes is not used with headTail");
          headBudget = args.headBytes;
          tailBudget = args.tailBytes;
        } else {
          if (args.headBytes !== undefined || args.tailBytes !== undefined) throw new TypeError("headBytes and tailBytes are only for headTail");
          if (!isBudget(args.maxBytes)) throw new TypeError("maxBytes must be a non-negative integer");
          if (strategy === "head") headBudget = args.maxBytes;
          else tailBudget = args.maxBytes;
        }
        const text = args.text;
        const total = totalBytes(text);
        let kept = text;
        let keptBytes = total;
        if (total > headBudget + tailBudget) {
          const head = headFit(text, headBudget);
          const tail = tailFit(text, tailBudget);
          keptBytes = head.bytes + tail.bytes;
          const omitted = total - keptBytes;
          const headText = text.slice(0, head.units);
          const tailText = tail.units > 0 ? text.slice(text.length - tail.units) : "";
          kept = strategy === "headTail" ? `${headText}\n[... omitted ${omitted} bytes ...]\n${tailText}` : headText + tailText;
        }
        const omittedBytes = total - keptBytes;
        return ({
          text: kept,
          truncated: omittedBytes > 0,
          totalBytes: total,
          keptBytes,
          omittedBytes,
          notice: omittedBytes > 0 ? `Omitted ${omittedBytes} bytes.` : "",
        });
      }),
    }));
  },
  deactivate() {
    while (disposables.length > 0) disposables.pop().dispose();
  },
};
