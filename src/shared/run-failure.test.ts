import { describe, expect, it } from "vitest";
import { publicRunFailure } from "./run-failure";

describe("public run failure metadata", () => {
 it.each([
  ["MEMORY_CONTEXT_TRANSCRIPT_SECRET", "context"],
  ["MEMORY_CONTEXT_TOOL_PAIR_INVALID", "context"],
  ["MEMORY_CONTEXT_BUDGET_EXCEEDED", "context"],
  ["MEMORY_CONTEXT_RECENT_OVER_BUDGET", "context"],
  ["MEMORY_CONTEXT_COUNT_FAILED", "context"],
  ["MEMORY_CONTEXT_FIXED_OVER_BUDGET", "context"],
  ["E_MODEL_REQUEST_FAILED", "model"],
  ["E_MODEL_RESPONSE_PARSE_FAILED", "model"],
  ["E_SHELL_EXIT", "tool"],
 ] as const)("keeps the known code %s and its source", (code, source)=>{
  expect(publicRunFailure({code,message:"SYNTHETIC_SECRET_MUST_NOT_ESCAPE"})).toEqual({code,source});
 });
 it("does not publish arbitrary errors, fake codes, sources, messages or causes",()=>{
  const result=publicRunFailure({code:"MEMORY_PRIVATE_CANARY",source:"model",message:"SYNTHETIC_SECRET",cause:{token:"SYNTHETIC_SECRET"}},"context");
  expect(result).toEqual({code:"E_CONTEXT_FAILURE",source:"context"});
  expect(JSON.stringify(result)).not.toContain("CANARY");
  expect(publicRunFailure(new Error("SYNTHETIC_SECRET"))).toEqual({code:"E_HARNESS_FAILURE",source:"runtime"});
 });
 it("accepts exact reason-only errors without parsing arbitrary error text",()=>{
  expect(publicRunFailure(new Error("MEMORY_CONTEXT_TRANSCRIPT_SECRET"))).toEqual({code:"MEMORY_CONTEXT_TRANSCRIPT_SECRET",source:"context"});
  expect(publicRunFailure(new Error("prefix MEMORY_CONTEXT_TRANSCRIPT_SECRET SYNTHETIC_SECRET"))).toEqual({code:"E_HARNESS_FAILURE",source:"runtime"});
 });
});
