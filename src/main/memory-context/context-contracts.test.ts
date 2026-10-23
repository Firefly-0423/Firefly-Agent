import { describe, expect, it } from "vitest";
import { CONTEXT_CLAIM_WINDOW_MS, ContextError, contextFail } from "./context-contracts";

describe("ContextError", () => {
  it("carries the reason code as message, code and name", () => {
    const error = new ContextError("MEMORY_CONTEXT_TRANSCRIPT_STALE");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ContextError);
    expect(error.name).toBe("ContextError");
    expect(error.message).toBe("MEMORY_CONTEXT_TRANSCRIPT_STALE");
    expect(error.code).toBe("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  });

  it("is not treated as a provider/body payload carrier", () => {
    const error = new ContextError("MEMORY_CONTEXT_ACCESS_DENIED");
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toMatch(/\s/);
  });
});

describe("contextFail", () => {
  it("throws a ContextError with the exact reason code", () => {
    let caught: unknown;
    try {
      contextFail("MEMORY_CONTEXT_INPUT_INVALID");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContextError);
    expect((caught as ContextError).code).toBe("MEMORY_CONTEXT_INPUT_INVALID");
    expect((caught as Error).message).toBe("MEMORY_CONTEXT_INPUT_INVALID");
  });

  it("works through expect(...).toThrow", () => {
    expect(() => contextFail("MEMORY_CONTEXT_TRANSCRIPT_DENIED")).toThrow("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
  });
});

describe("context constants", () => {
  it("keeps the claim window at the documented five seconds", () => {
    expect(CONTEXT_CLAIM_WINDOW_MS).toBe(5000);
  });
});
