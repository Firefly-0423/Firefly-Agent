import { describe, expect, it, vi, beforeEach } from "vitest";
import { readImageUrlTool, clearImageCaptionCache } from "./read-image-url-tool";
import { captionImage } from "../../vision-captioner";
vi.mock("../../../settings/model-settings", () => ({ loadModelSettings: () => ({}), resolveModelSettingsProfile: () => ({}) }));
vi.mock("../../image-router", () => ({ resolveCaptionVisionConfig: () => ({ ok: true, config: { model: "fixture-vision-73" } }) }));
vi.mock("../../vision-captioner", () => ({ captionImage: vi.fn() }));

const caption = vi.mocked(captionImage);
const url = "https://images.example/observatory.webp";
beforeEach(() => { clearImageCaptionCache(); caption.mockReset(); });

describe("caption reuse for remote images", () => {
  it("reuses the same image and question with a visible freshness annotation", async () => {
    caption.mockResolvedValue("A telescope beneath a clear sky.");
    const args = { url };
    const context = { userQuery: "Describe the equipment" };
    const initial = await readImageUrlTool.execute(args, context);
    const repeated = await readImageUrlTool.execute(args, context);
    expect(initial).toContain("telescope");
    expect(initial.startsWith("[缓存]")).toBe(false);
    expect(repeated).toContain("telescope");
    expect(repeated.startsWith("[缓存]")).toBe(true);
    expect(caption).toHaveBeenCalledTimes(1);
  });
  it("keeps different questions independent even for the same URL", async () => {
    caption.mockResolvedValue("An observation.");
    for (const userQuery of ["Name the equipment", "Count the stars"]) await readImageUrlTool.execute({ url }, { userQuery });
    expect(caption).toHaveBeenCalledTimes(2);
  });
  it("does not retain a failed description", async () => {
    caption.mockResolvedValueOnce("[错误] Image service unavailable").mockResolvedValueOnce("A moonlit observatory.");
    expect((await readImageUrlTool.execute({ url }, { userQuery: "Describe the scene" })).startsWith("[错误")).toBe(true);
    const recovered = await readImageUrlTool.execute({ url }, { userQuery: "Describe the scene" });
    expect(recovered).toContain("observatory");
    expect(recovered.startsWith("[缓存]")).toBe(false);
    expect(caption).toHaveBeenCalledTimes(2);
  });
});
