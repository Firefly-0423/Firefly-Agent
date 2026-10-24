import { describe, expect, it } from "vitest";
import {
  USER_ANNOTATION_NOTICE,
  buildTurnModelContext,
  userAnnotationNotice,
} from "./chat-context";

describe("userAnnotationNotice", () => {
  it("returns the notice only when the image has user annotations", () => {
    expect(userAnnotationNotice(true)).toBe(USER_ANNOTATION_NOTICE);
    expect(userAnnotationNotice(false)).toBeUndefined();
  });

  it("describes annotations without guessing a location or asserting an error", () => {
    expect(USER_ANNOTATION_NOTICE).toContain("用户主动添加的视觉标注");
    expect(USER_ANNOTATION_NOTICE).toContain("不表示该区域一定存在错误");
    expect(USER_ANNOTATION_NOTICE).not.toMatch(/左上|右上|左下|右下/);
  });
});

describe("buildTurnModelContext", () => {
  it("returns undefined when there is no context", () => {
    expect(buildTurnModelContext({})).toBeUndefined();
    expect(buildTurnModelContext({
      fileHints: [],
      documentContextLines: [],
      imageCaptionLines: [],
      directImageLines: [],
    })).toBeUndefined();
  });

  it("builds a single section without a trailing separator", () => {
    expect(buildTurnModelContext({ fileHints: ["a.txt", "b.txt"] })).toBe("【本轮文件】\na.txt\nb.txt");
  });

  it("keeps sections in file/document/image/direct-image order", () => {
    const context = buildTurnModelContext({
      directImageLines: ["- direct.png"],
      imageCaptionLines: ["- caption.png"],
      documentContextLines: ["doc one", "doc two"],
      fileHints: ["hint"],
    });

    expect(context).toBe(
      "【本轮文件】\nhint\n\n" +
      "【文档内容】\ndoc one\n\ndoc two\n\n" +
      "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n- caption.png\n\n" +
      "【图片附件】\n以下图片已随本轮消息直接发送给主模型，请直接结合图片内容回答。\n- direct.png",
    );
  });

  it("uses a blank line between document lines but a single newline between file hints", () => {
    const context = buildTurnModelContext({ documentContextLines: ["one", "two"] });
    expect(context).toBe("【文档内容】\none\n\ntwo");
  });

  it("does not let later sections replace earlier ones", () => {
    const context = buildTurnModelContext({
      documentContextLines: ["failed to process report.md"],
      imageCaptionLines: ["- chart.png: sales trend"],
    });
    expect(context?.indexOf("failed to process")).toBeLessThan(context?.indexOf("- chart.png") ?? -1);
    expect(context).toContain("failed to process report.md");
    expect(context).toContain("- chart.png: sales trend");
  });

  it("drops sections whose arrays are empty even when other sections are present", () => {
    expect(buildTurnModelContext({
      fileHints: [],
      documentContextLines: ["doc"],
      imageCaptionLines: [],
      directImageLines: [],
    })).toBe("【文档内容】\ndoc");
  });
});
