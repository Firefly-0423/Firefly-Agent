import { expect, it, describe } from "vitest";
import { buildMiniMaxErrorMessage, createUniqueMiniMaxVoiceId, validateMiniMaxVoiceId } from "./minimax-voice";

describe("voice identifiers submitted to MiniMax", () => {
  it.each([
    ["short", "8 到 256"], ["3narrator_demo", "英文字母"],
    ["narrator_demo_", "不能是 - 或 _"], ["narrator demo", "仅能包含"],
  ])("explains why %s is invalid", (id, explanation) => {
    expect(validateMiniMaxVoiceId(id)).toContain(explanation);
  });
  it.each([8, 256])("accepts the inclusive length boundary %s", length => {
    expect(validateMiniMaxVoiceId("v".repeat(length))).toBeNull();
  });
  it.each([7, 257])("rejects length %s outside the bounds", length => {
    expect(validateMiniMaxVoiceId("v".repeat(length))).toBe("音色 ID 长度需在 8 到 256 个字符之间。");
  });
  it("builds a valid UTC identifier with a deterministic random component", () => {
    const id = createUniqueMiniMaxVoiceId(() => 0.5, new Date("2025-02-03T04:05:06Z"));
    expect(id).toMatch(/^firefly-voice-20250203-040506-[a-z0-9]+$/);
    expect(id).toBe("firefly-voice-20250203-040506-i00000");
    expect(validateMiniMaxVoiceId(id)).toBeNull();
  });
});

describe("voice service diagnostics", () => {
  it("uses actionable duplicate guidance even without a server detail", () => {
    expect(buildMiniMaxErrorMessage(2039)).toEqual("音色 ID 已存在。请使用一个新的音色 ID 后再试（错误码 2039）。");
    expect(buildMiniMaxErrorMessage(2039, undefined, "voice-request-42"))
      .toEqual("音色 ID 已存在。请使用一个新的音色 ID 后再试（错误码 2039；trace_id voice-request-42）。");
  });
  it("retains an unrecognized code and its server explanation", () => {
    expect(buildMiniMaxErrorMessage(2876, "upstream queue full"))
      .toEqual("MiniMax 请求失败：upstream queue full（错误码 2876）。");
  });
});