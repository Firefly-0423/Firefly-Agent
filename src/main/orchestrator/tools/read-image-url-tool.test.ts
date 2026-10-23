import { expect, it, vi, beforeEach, describe } from "vitest";
vi.mock("../../settings/model-settings", () => ({ loadModelSettings: vi.fn(), resolveModelSettingsProfile: vi.fn() }));
vi.mock("../image-router", () => ({ resolveCaptionVisionConfig: vi.fn() }));
vi.mock("../vision-captioner", () => ({ captionImage: vi.fn() }));
import { readImageUrlTool, clearImageCaptionCache } from "./builtin-tools/read-image-url-tool";
import { resolveCaptionVisionConfig } from "../image-router";
import { captionImage } from "../vision-captioner";

const route = vi.mocked(resolveCaptionVisionConfig);
const caption = vi.mocked(captionImage);
const configuration = { baseUrl: "https://vision.example/v1", apiKey: "fixture-key-73", model: "vision-fixture" };
beforeEach(() => { vi.resetAllMocks(); clearImageCaptionCache(); });

describe("remote image input and vision routing", () => {
  it("rejects unsupported URL schemes without invoking vision", async () => {
    await expect(readImageUrlTool.execute({ url: "file:///observatory.png" }, { userQuery: "Describe this" }))
      .resolves.toEqual("[错误] url 必须以 http:// 或 https:// 开头");
    expect(caption).not.toHaveBeenCalled();
  });
  it.each([
    "当前主模型不是多模态，且未配置独立视觉模型。请在「设置 → API 设置 → 视觉模型」中配置，或切换到多模态主模型。",
    "主模型走 Anthropic 协议，工具读图需要 OpenAI 兼容的独立视觉模型。请在「设置 → API 设置 → 视觉模型」中配置。",
  ])("surfaces a routing refusal verbatim: %s", async (error) => {
    route.mockReturnValue({ ok: false, error });
    expect(await readImageUrlTool.execute({ url: "https://images.example/rejected.png" }, { userQuery: "Describe this" }))
      .toEqual("[错误·配置] " + error);
    expect(caption).not.toHaveBeenCalled();
  });
  it("forwards the public URL, user question and selected configuration", async () => {
    route.mockReturnValue({ ok: true, config: configuration });
    caption.mockResolvedValue("A brass telescope.");
    const url = "https://images.example/telescope.png";
    const output = await readImageUrlTool.execute({ url }, { userQuery: "Which instrument is shown?" });
    expect(output).toEqual("A brass telescope.");
    expect(caption).toHaveBeenCalledTimes(1);
    expect(caption).toHaveBeenCalledWith({ url }, "Which instrument is shown?", configuration);
    expect(caption.mock.calls[0][0]).not.toHaveProperty("base64");
  });
  it("uses an empty question when no calling context exists", async () => {
    route.mockReturnValue({ ok: true, config: configuration });
    caption.mockResolvedValue("A night sky.");
    await readImageUrlTool.execute({ url: "https://images.example/no-question.png" });
    expect(caption.mock.calls[0][1]).toEqual("");
  });
});
