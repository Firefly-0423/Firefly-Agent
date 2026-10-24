import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../vendors";
import { ContextRefRegistry } from "../../context-ref-registry";
import {
  contextRefRegistry,
  createToolInvocationContext,
  extractLastUserQuery,
  getToolRunScope,
  type ToolContext,
} from "./tool-context";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { userQuery: "hello", conversationId: "conv-1", ...overrides };
}

function message(role: ChatMessage["role"], content: unknown): ChatMessage {
  return { role, content } as ChatMessage;
}

describe("contextRefRegistry", () => {
  it("is a shared registry instance", () => {
    expect(contextRefRegistry).toBeInstanceOf(ContextRefRegistry);
  });
});

describe("getToolRunScope", () => {
  it("returns one frozen identity per context", () => {
    const ctx = context();
    const scope = getToolRunScope(ctx);
    expect(scope).toBe(getToolRunScope(ctx));
    expect(Object.isFrozen(scope)).toBe(true);

    const other = context();
    expect(getToolRunScope(other)).not.toBe(scope);
  });
});

describe("createToolInvocationContext", () => {
  it("copies the parent context and overrides only the invocation fields", () => {
    const parent = context({
      userQuery: "original",
      metadata: { source: "test" },
      resolvedWorkspaceRoot: "/workspace",
    });
    const execution = { coordinator: {}, scope: {} } as never;
    const authorizedToolCall = { toolId: "demo", args: { a: 1 }, approvalRequired: false };
    const child = createToolInvocationContext(parent, { execution, authorizedToolCall });

    expect(child).not.toBe(parent);
    expect(child).toEqual({ ...parent, execution, authorizedToolCall });
    expect(child.userQuery).toBe("original");
    expect(child.metadata).toBe(parent.metadata);
    expect(parent).not.toHaveProperty("execution");
    expect(getToolRunScope(child)).toBe(getToolRunScope(parent));
  });

  it("does not share the invocation scope with unrelated contexts", () => {
    const parent = context();
    const child = createToolInvocationContext(parent, { execution: undefined });
    expect(getToolRunScope(child)).not.toBe(getToolRunScope(context()));
  });
});

describe("extractLastUserQuery", () => {
  it("returns an empty string for no messages or no user message", () => {
    expect(extractLastUserQuery([])).toBe("");
    expect(extractLastUserQuery([message("assistant", "reply")])).toBe("");
    expect(extractLastUserQuery([message("system", "prompt")])).toBe("");
  });

  it("returns the last user message text, not the last message", () => {
    expect(
      extractLastUserQuery([
        message("user", "first question"),
        message("assistant", "answer"),
        message("user", "second question"),
        message("assistant", "final answer"),
      ]),
    ).toBe("second question");
  });

  it("preserves the exact string content", () => {
    expect(extractLastUserQuery([message("user", "  spaced  ")])).toBe("  spaced  ");
  });

  it("joins text blocks from multimodal array content and ignores other blocks", () => {
    const content = [
      { type: "text", text: "look at" },
      { type: "image", url: "https://example.test/a.png" },
      null,
      "raw",
      { type: "text", text: "this" },
      { type: "text" },
    ];
    expect(extractLastUserQuery([message("user", content)])).toBe("look at this");
  });

  it("returns an empty string when array content has no text block", () => {
    expect(extractLastUserQuery([message("user", [])])).toBe("");
    expect(
      extractLastUserQuery([message("user", [{ type: "image", text: "ignored?" }])]),
    ).toBe("");
  });

  it("returns an empty string for unsupported content shapes", () => {
    expect(extractLastUserQuery([message("user", 42)])).toBe("");
    expect(extractLastUserQuery([message("user", null)])).toBe("");
  });
});
