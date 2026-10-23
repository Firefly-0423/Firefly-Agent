import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildImageCaptionPrompt, validateCaptionImagePath, IMAGE_CAPTION_MAX_BYTES, IMAGE_CAPTION_PROMPT } from "./image-caption";
let folder: string;
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "caption-contract-")); });
afterEach(() => rmSync(folder, { force: true, recursive: true }));
describe("caption input contract", () => {
    it("returns the original image bytes and MIME for an accepted file", () => {
        const filePath = join(folder, "scene.PNG");
        const bytes = Buffer.from([19, 27, 81, 96]);
        writeFileSync(filePath, bytes);
        expect(validateCaptionImagePath(filePath)).toEqual({ ok: true, filePath, mime: "image/png", buffer: bytes });
    });
    it("distinguishes missing paths, non-files, wrong types and unsupported formats", () => {
        const document = join(folder, "draft.md");
        writeFileSync(document, "not an image");
        const cases = [
            [null, "filePath 必须是 string"], [join(folder, "absent.webp"), "文件不存在"],
            [folder, "不是文件"], [document, "只支持图片文件"],
        ] as const;
        for (const [input, error] of cases)
            expect(validateCaptionImagePath(input)).toEqual({ ok: false, error });
    });
    it("accepts exactly the size limit and rejects one additional byte", () => {
        const filePath = join(folder, "ceiling.png");
        writeFileSync(filePath, Buffer.alloc(IMAGE_CAPTION_MAX_BYTES, 5));
        expect(validateCaptionImagePath(filePath).ok).toEqual(true);
        writeFileSync(filePath, Buffer.alloc(IMAGE_CAPTION_MAX_BYTES + 1, 5));
        expect(validateCaptionImagePath(filePath)).toEqual({ error: "图片不能超过 20MB", ok: false });
    });
    it("uses the base prompt and adds the user's annotation guidance conditionally", () => {
        expect(buildImageCaptionPrompt(false)).toEqual(IMAGE_CAPTION_PROMPT);
        expect(buildImageCaptionPrompt(true)).toContain("用户主动添加");
    });
});
