import { it, expect, describe } from "vitest";
import { DEFAULT_IMAGE_TOKEN_ESTIMATE, estimateMessageContentTokens as contentCost, estimateMessageTokens as messageCost } from "./context-manager";
import type { OpenAIContentBlock } from "./vendors/types";

describe("Context estimates for model input", () => {
  const picture = (url: string): OpenAIContentBlock => ({ type: "image_url", image_url: { url } });

  it("adds one fixed image charge per attachment irrespective of encoded size", () => {
    const attachments = [picture("data:image/jpeg;base64," + "Q".repeat(1_200_000)), picture("https://assets.invalid/photo.png")];
    expect(contentCost([attachments[0]])).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE);
    expect(contentCost(attachments)).toBe(2 * DEFAULT_IMAGE_TOKEN_ESTIMATE);
    expect(messageCost([{ role: "user", content: [attachments[0]] }])).toBe(4 + DEFAULT_IMAGE_TOKEN_ESTIMATE);
  });

  it("uses the same text estimate in either representation and adds it to images", () => {
    const words = "请描述附件里的桥梁";
    const textBlock: OpenAIContentBlock = { type: "text", text: words };
    expect(contentCost(words)).toBeGreaterThan(0);
    expect(contentCost([textBlock])).toBe(contentCost(words));
    expect(contentCost([picture("data:image/png;base64,cGlj"), textBlock])).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE + contentCost(words));
  });

  it("does not charge for an empty content array", () => {
    expect(contentCost([])).toEqual(0);
  });
});
