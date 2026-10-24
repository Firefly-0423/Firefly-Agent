import { describe, expect, it } from "vitest";
import { classifyToolError, classifyToolResultError } from "./error-classifier";
import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import type { ToolCallResult } from "../types";

const failed = (fields: Partial<ToolCallResult> = {}): ToolCallResult => ({
  status: "failed", toolId: "scan_archive", args: { section: 7 }, output: "", ...fields,
});

describe("Error signals used for retry decisions", () => {
  it("honors typed categories before timeout-like text or generic codes", () => {
    expect(classifyToolError(new ToolExecutionError("E_REMOTE_BUSY", "timeout while throttled", "rate_limited", true))).toEqual("rate_limited");
    expect(classifyToolResultError(failed({ errorCode: "TOOL_TIMEOUT", category: "fatal" }))).toEqual("fatal");
    expect(classifyToolResultError(failed({ category: "runtime_safety" }))).toEqual("runtime_safety");
  });

  it("treats arbitrary thrown values as transient without trusting a message property", () => {
    const thrown = [null, undefined, 97, "failure payload", { message: "timeout" }];
    expect(thrown.map(classifyToolError)).toEqual(thrown.map(() => "transient"));
    const aborted = Object.assign(new Error("request cancelled"), { name: "AbortError" });
    expect(classifyToolError(aborted)).toEqual("timeout");
  });

  const errorGroups = {
    timeout: ["remote timeout", "连接超时"],
    permission_denied: ["permission refused", "没有权限", "EPERM during write"],
    not_found: ["entry not found", "ENOENT opening archive", "条目不存在"],
    rate_limited: ["rate limit reached", "response 429", "降低速率"],
    invalid_arguments: ["invalid argument supplied", "EINVAL from parser", "参数错误，请重新填写"],
    fatal: ["fatal allocation", "FATAL shutdown", "ENOMEM allocation", "heap out of memory"],
    transient: ["ECONNRESET from peer", "一般处理错误"],
  };
  for (const [category, messages] of Object.entries(errorGroups)) {
    it(`classifies the supported Error spellings as ${category}`, () => {
      expect(messages.map(text => classifyToolError(new Error(text)))).toEqual(messages.map(() => category));
    });
  }

  it("classifies structured result codes and Chinese timeout output before fallback flags", () => {
    const groups = [
      ["timeout", ["REMOTE_TIMEOUT"]], ["permission_denied", ["PERMISSION_DENIED", "EPERM"]],
      ["not_found", ["NOT_FOUND", "ENOENT"]], ["rate_limited", ["RATE_LIMIT", "HTTP_429"]],
      ["invalid_arguments", ["INVALID_ARG", "EINVAL"]], ["fatal", ["FATAL", "OOM"]],
    ] as const;
    for (const [category, codes] of groups) {
      expect(codes.map(errorCode => classifyToolResultError(failed({ errorCode, retryable: true, terminal: false })))).toEqual(codes.map(() => category));
    }
    expect(classifyToolResultError(failed({ output: "远程执行超时" }))).toEqual("timeout");
  });

  it("uses retryability before partial termination, then falls back to semantic failure", () => {
    expect([
      { retryable: true }, { retryable: true, terminal: false },
      { terminal: false }, {}, { terminal: true },
    ].map(fields => classifyToolResultError(failed(fields)))).toEqual([
      "transient", "transient", "partial_failure", "semantic_failure", "semantic_failure",
    ]);
  });
});
