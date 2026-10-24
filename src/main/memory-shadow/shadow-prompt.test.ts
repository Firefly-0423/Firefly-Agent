import { describe, expect, it } from "vitest";
import { SHADOW_ATTRIBUTES, SHADOW_LIMITS } from "./shadow-contracts";
import { prepareShadowRequest, SHADOW_PROMPT_VERSION } from "./shadow-prompt";

const user = (text: string) => ({ id: "user-1", text });

describe("prepareShadowRequest", () => {
  it.each(["", "   ", "\n\t"])("skips a blank user message (%j)", (text) => {
    expect(prepareShadowRequest({ user: user(text) })).toEqual({ send: false, reason: "empty" });
  });

  it("skips a non-string user text", () => {
    expect(prepareShadowRequest({ user: { id: "u", text: 42 as unknown as string } })).toEqual({
      send: false,
      reason: "empty",
    });
  });

  it("skips a user message longer than the limit", () => {
    expect(prepareShadowRequest({ user: user("a".repeat(SHADOW_LIMITS.maxUserChars)) }).send).toBe(true);
    expect(
      prepareShadowRequest({ user: user("a".repeat(SHADOW_LIMITS.maxUserChars + 1)) }),
    ).toEqual({ send: false, reason: "too-long" });
  });

  it("skips messages the conservative extractor classifies as secrets", () => {
    expect(prepareShadowRequest({ user: user("my password is hunter2") })).toEqual({
      send: false,
      reason: "secret",
    });
    expect(prepareShadowRequest({ user: user("我的密码是 hunter2") })).toEqual({
      send: false,
      reason: "secret",
    });
  });

  it("skips messages containing credential-shaped values", () => {
    expect(
      prepareShadowRequest({ user: user("deploy key ghp_abcdefghijklmnopqrstuvwx") }),
    ).toEqual({ send: false, reason: "secret" });
  });

  it("builds a user-only request with the versioned system prompt", () => {
    const request = prepareShadowRequest({ user: user("I prefer dark mode") });
    expect(request.send).toBe(true);
    if (!request.send) return;
    expect(request.version).toBe(SHADOW_PROMPT_VERSION);
    expect(request.assistantIncluded).toBe(false);
    expect(JSON.parse(request.user)).toEqual({ userMessage: "I prefer dark mode" });
    expect(request.system).toContain(`at most ${SHADOW_LIMITS.maxCandidates}`);
    expect(request.system).toContain(`max ${SHADOW_LIMITS.maxValueChars}`);
    expect(request.system).toContain(`max ${SHADOW_LIMITS.maxQuoteChars}`);
    for (const attribute of SHADOW_ATTRIBUTES) expect(request.system).toContain(`"${attribute}"`);
  });

  it("includes the previous assistant reply as context without rewriting it", () => {
    const request = prepareShadowRequest({
      user: user("yes, exactly"),
      previousAssistant: { id: "assistant-1", text: "  Do you use PowerShell?  " },
    });
    expect(request.send).toBe(true);
    if (!request.send) return;
    expect(request.assistantIncluded).toBe(true);
    expect(JSON.parse(request.user)).toEqual({
      previousAssistantReply: "  Do you use PowerShell?  ",
      userMessage: "yes, exactly",
    });
  });

  it("omits blank assistant replies", () => {
    const request = prepareShadowRequest({
      user: user("I prefer dark mode"),
      previousAssistant: { id: "assistant-1", text: "   " },
    });
    expect(request.send).toBe(true);
    if (!request.send) return;
    expect(request.assistantIncluded).toBe(false);
    expect(JSON.parse(request.user)).toEqual({ userMessage: "I prefer dark mode" });
  });

  it("omits assistant replies that look like they contain credentials", () => {
    const request = prepareShadowRequest({
      user: user("I prefer dark mode"),
      previousAssistant: { id: "assistant-1", text: "Use this key: sk-abcdefghijklmnopqrstuvwx" },
    });
    expect(request.send).toBe(true);
    if (!request.send) return;
    expect(request.assistantIncluded).toBe(false);
    expect(request.user).not.toContain("sk-");
  });

  it("keeps only the tail of an over-long assistant reply", () => {
    const assistant = "x".repeat(SHADOW_LIMITS.maxAssistantChars + 500) + "TAIL";
    const request = prepareShadowRequest({
      user: user("I prefer dark mode"),
      previousAssistant: { id: "assistant-1", text: assistant },
    });
    expect(request.send).toBe(true);
    if (!request.send) return;
    const parsed = JSON.parse(request.user) as { previousAssistantReply: string };
    expect(parsed.previousAssistantReply).toHaveLength(SHADOW_LIMITS.maxAssistantChars);
    expect(parsed.previousAssistantReply.endsWith("TAIL")).toBe(true);
  });

  it("always includes the no-evidence instruction for the assistant context", () => {
    const request = prepareShadowRequest({ user: user("I prefer dark mode") });
    if (!request.send) throw new Error("expected send");
    expect(request.system).toContain("This is the ONLY source of evidence");
    expect(request.system).toContain("Never use it as evidence");
  });
});
