import { describe, expect, it } from "vitest";
import { buildTurnModelContext, userAnnotationNotice, USER_ANNOTATION_NOTICE } from "../shared/chat-context";
describe("model context assembled from attachments", () => {
    it("omits empty context", () => expect(buildTurnModelContext({})).toBeUndefined());
    it("retains file, failed document, caption and direct-image sections in order", () => {
        const result = buildTurnModelContext({
            directImageLines: ["- garden.jpeg: attached directly"],
            imageCaptionLines: ["- map.webp: river crossings"],
            fileHints: ["outline.md: indexed 6 passages"],
            documentContextLines: ["inventory.csv: parser unavailable\nExplain the failure without inventing content."],
        });
        expect(result).toEqual([
            "【本轮文件】\noutline.md: indexed 6 passages",
            "【文档内容】\ninventory.csv: parser unavailable\nExplain the failure without inventing content.",
            "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n- map.webp: river crossings",
            "【图片附件】\n以下图片已随本轮消息直接发送给主模型，请直接结合图片内容回答。\n- garden.jpeg: attached directly",
        ].join("\n\n"));
    });
    it("adds an annotation notice only for annotated images without guessing a location", () => {
        expect(userAnnotationNotice(false)).toBeUndefined();
        const notice = userAnnotationNotice(true);
        expect(notice).toEqual(USER_ANNOTATION_NOTICE);
        expect(notice).toContain("用户主动添加");
        expect(notice).not.toContain("右上");
    });
});
