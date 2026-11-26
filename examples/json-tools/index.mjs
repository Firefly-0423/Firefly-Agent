// Pure computation through the Firefly plugin API 1.2. No runtime SDK dependency, no Node facilities.
// The lossless-JSON rules and the structural comparison are adapted from deepseek-harness
// packages/util/values (MIT, Copyright (c) 2026 DeepSeek); see LICENSE and README.md.
const VALIDATE_ID = "json-tools_validate";
const COMPARE_ID = "json-tools_compare";
const MAX_CHARS = 1_000_000;
const MAX_MESSAGE = 300;
const MAX_PATH = 200;
const disposables = [];

function rootType(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function cap(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function childPath(path, step) {
  if (typeof step === "number") return `${path}[${step}]`;
  return IDENTIFIER.test(step) ? `${path}.${step}` : `${path}[${JSON.stringify(step)}]`;
}

/** Own enumerable keys only; parsed JSON has no other kind, and inherited names such as "toString" must stay ordinary data. */
function keysOf(object) {
  return Object.keys(object);
}
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Iterative walk (no recursion limit) that finds the first value JSON text cannot round-trip: -0 or a non-finite number. */
function findLossy(root) {
  const stack = [{ value: root, path: "$" }];
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    const { value, path } = task;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { path, message: "number is not finite" };
      if (Object.is(value, -0)) return { path, message: "negative zero is not preserved" };
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push({ value: value[index], path: childPath(path, index) });
    } else if (value !== null && typeof value === "object") {
      const keys = keysOf(value);
      for (let index = keys.length - 1; index >= 0; index--) stack.push({ value: value[keys[index]], path: childPath(path, keys[index]) });
    }
  }
  return undefined;
}

function parse(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { syntaxError: cap(String(error && error.message ? error.message : error), MAX_MESSAGE) };
  }
}

function assertSize(text, name) {
  if (text.length > MAX_CHARS) throw new RangeError(`${name} must be at most ${MAX_CHARS} characters`);
}

/** First difference in document order: arrays by index, object keys in the left document's order, then keys only in the right. */
function firstDifference(left, right) {
  const stack = [{ left, right, path: "$" }];
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    if (task.missing) return { path: task.path, kind: "missing-in-right" };
    if (task.extras) {
      for (const key of keysOf(task.right)) {
        if (!hasOwn(task.left, key)) return { path: childPath(task.path, key), kind: "missing-in-left" };
      }
      continue;
    }
    const a = task.left;
    const b = task.right;
    if (a === b) continue;
    const typeA = rootType(a);
    const typeB = rootType(b);
    if (typeA !== typeB) return { path: task.path, kind: "type" };
    if (typeA === "array") {
      if (a.length !== b.length) return { path: task.path, kind: "length" };
      for (let index = a.length - 1; index >= 0; index--) stack.push({ left: a[index], right: b[index], path: childPath(task.path, index) });
    } else if (typeA === "object") {
      stack.push({ extras: true, left: a, right: b, path: task.path });
      const keys = keysOf(a);
      // Missing keys are reported at their position in the left document's order, so check them while walking in order.
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        stack.push(hasOwn(b, key)
          ? { left: a[key], right: b[key], path: childPath(task.path, key) }
          : { missing: true, path: childPath(task.path, key) });
      }
    } else {
      return { path: task.path, kind: "value" };
    }
  }
  return undefined;
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
      name: VALIDATE_ID,
      description: "校验一段文本是否为合法且无损的 JSON：语法正确，且不含无法往返的值（负零、溢出为无穷大的数字）。有效时返回根类型；无效时返回原因和位置路径。全部离线处理，不保存原文。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: `要校验的 JSON 文本，最多 ${MAX_CHARS} 个字符` } },
        required: ["text"],
      },
      execute: offline((args) => {
        if (!args || typeof args.text !== "string") throw new TypeError("text must be a string");
        assertSize(args.text, "text");
        const parsed = parse(args.text);
        if ("syntaxError" in parsed) return ({ valid: false, reason: "syntax", message: parsed.syntaxError });
        const lossy = findLossy(parsed.value);
        if (lossy) return ({ valid: false, reason: "lossy", path: cap(lossy.path, MAX_PATH), message: lossy.message });
        return ({ valid: true, type: rootType(parsed.value) });
      }),
    }));
    disposables.push(ctx.tools.register({
      name: COMPARE_ID,
      description: "按结构比较两段 JSON 文本：忽略对象键顺序和数字写法（1 与 1.0 相同），数组顺序有意义。相同返回 equal=true；不同返回文档顺序中的第一处差异路径和类别（type、value、length、missing-in-left、missing-in-right）。两段文本都必须是合法且无损的 JSON。",
      parameters: {
        type: "object",
        properties: {
          left: { type: "string", description: `第一段 JSON 文本，最多 ${MAX_CHARS} 个字符` },
          right: { type: "string", description: `第二段 JSON 文本，最多 ${MAX_CHARS} 个字符` },
        },
        required: ["left", "right"],
      },
      execute: offline((args) => {
        if (!args || typeof args.left !== "string" || typeof args.right !== "string") throw new TypeError("left and right must be strings");
        assertSize(args.left, "left");
        assertSize(args.right, "right");
        const documents = {};
        for (const side of ["left", "right"]) {
          const parsed = parse(args[side]);
          if ("syntaxError" in parsed) throw new Error(`${side} is not valid JSON: ${parsed.syntaxError}`);
          const lossy = findLossy(parsed.value);
          if (lossy) throw new Error(`${side} is not lossless JSON at ${cap(lossy.path, MAX_PATH)}: ${lossy.message}`);
          documents[side] = parsed.value;
        }
        const difference = firstDifference(documents.left, documents.right);
        return (difference ? { equal: false, difference } : { equal: true });
      }),
    }));
  },
  deactivate() {
    while (disposables.length > 0) disposables.pop().dispose();
  },
};
