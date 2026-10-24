import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import type { ToolErrorCategory } from "./types";
import type { ToolCallResult } from "../types";

type CategoryRule = readonly [ToolErrorCategory, readonly string[]];

const exceptionRules: readonly CategoryRule[] = [
  ["timeout", ["timeout", "超时"]],
  ["permission_denied", ["permission", "权限", "EPERM"]],
  ["not_found", ["not found", "ENOENT", "不存在"]],
  ["rate_limited", ["rate limit", "429", "速率"]],
  ["invalid_arguments", ["invalid argument", "参数错误", "EINVAL"]],
  ["fatal", ["fatal", "FATAL", "ENOMEM", "heap out of memory"]],
];
const resultRules: readonly CategoryRule[] = [
  ["permission_denied", ["PERMISSION", "EPERM"]],
  ["not_found", ["NOT_FOUND", "ENOENT"]],
  ["rate_limited", ["RATE_LIMIT", "429"]],
  ["invalid_arguments", ["INVALID_ARG", "EINVAL"]],
  ["fatal", ["FATAL", "OOM"]],
];

function matchCategory(text: string, rules: readonly CategoryRule[]): ToolErrorCategory | undefined {
  for (const [category, fragments] of rules) {
    if (fragments.some(fragment => text.includes(fragment))) return category;
  }
  return undefined;
}

export function classifyToolError(thrown: unknown): ToolErrorCategory {
  if (thrown instanceof ToolExecutionError) return thrown.category;
  if (!(thrown instanceof Error)) return "transient";
  const detail = thrown.message;
  if (thrown.name === "AbortError") return "timeout";
  return matchCategory(detail, exceptionRules) ?? "transient";
}

export function classifyToolResultError(failed: ToolCallResult): ToolErrorCategory {
  if (failed.category) return failed.category;
  const identifier = failed.errorCode ?? "";
  const transcript = failed.output ?? "";
  if (identifier.includes("TIMEOUT") || transcript.includes("超时")) return "timeout";
  const matched = matchCategory(identifier, resultRules);
  if (matched) return matched;
  if (failed.retryable) return "transient";
  return failed.terminal === false ? "partial_failure" : "semantic_failure";
}
