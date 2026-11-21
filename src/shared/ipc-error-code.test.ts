import { describe, expect, it } from "vitest";
import { unwrapIpcErrorCode } from "./ipc-error-code";
import { publicRunFailure } from "./run-failure";

describe("unwrapIpcErrorCode", () => {
  it("recovers a bare code from Electron's invoke wrapper so the public vocabulary can classify it", () => {
    const wrapped = new Error("Error invoking remote method 'agui:run': Error: MEMORY_ATTACHMENT_NEEDS_WORK_MODE");
    const unwrapped = unwrapIpcErrorCode(wrapped);
    expect(unwrapped).toBeInstanceOf(Error);
    expect((unwrapped as Error).message).toBe("MEMORY_ATTACHMENT_NEEDS_WORK_MODE");
    expect(publicRunFailure(unwrapped)).toEqual({ code: "MEMORY_ATTACHMENT_NEEDS_WORK_MODE", source: "context" });
  });

  it.each([
    ["free text after the wrapper", "Error invoking remote method 'agui:run': Error: something broke at C:\\private\\path"],
    ["a code followed by extra text", "Error invoking remote method 'agui:run': Error: MEMORY_ATTACHMENT_NEEDS_WORK_MODE secret"],
    ["a code without the wrapper prefix", "prefix MEMORY_ATTACHMENT_NEEDS_WORK_MODE"],
    ["a lowercase token", "Error invoking remote method 'agui:run': Error: not_a_code"],
  ])("returns the original error for %s", (_label, message) => {
    const original = new Error(message);
    expect(unwrapIpcErrorCode(original)).toBe(original);
    expect(publicRunFailure(unwrapIpcErrorCode(original))).toEqual({ code: "E_HARNESS_FAILURE", source: "runtime" });
  });

  it("keeps an unknown wrapped code out of the public vocabulary", () => {
    const unwrapped = unwrapIpcErrorCode(new Error("Error invoking remote method 'agui:run': Error: PRIVATE_CANARY_CODE"));
    expect(publicRunFailure(unwrapped)).toEqual({ code: "E_HARNESS_FAILURE", source: "runtime" });
  });

  it("passes non-Error values through unchanged", () => {
    expect(unwrapIpcErrorCode("MEMORY_ATTACHMENT_NEEDS_WORK_MODE")).toBe("MEMORY_ATTACHMENT_NEEDS_WORK_MODE");
    expect(unwrapIpcErrorCode(undefined)).toBeUndefined();
  });
});
