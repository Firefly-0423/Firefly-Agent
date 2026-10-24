import * as fs from "fs";
import * as path from "path";
import { isImageExt, getMimeFromExt } from "../rag/file-ingest";
import { userAnnotationNotice } from "../../shared/chat-context";
import { captionImage, type VisionConfig } from "../orchestrator/vision-captioner";

export const IMAGE_CAPTION_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_CAPTION_PROMPT = "请简洁描述这张图片的主要内容，重点提取用户可能想让你看的信息。";

type CaptionFailure = { ok: false; error: string };
export type ValidCaptionImage =
  | CaptionFailure
  | { ok: true; filePath: string; buffer: Buffer; mime: string };

function rejectedImage(error: string): CaptionFailure {
  return { ok: false, error };
}

export function buildImageCaptionPrompt(hasAnnotations: boolean): string {
  const annotation = userAnnotationNotice(hasAnnotations);
  return annotation ? [IMAGE_CAPTION_PROMPT, annotation].join("\n\n") : IMAGE_CAPTION_PROMPT;
}

export function validateCaptionImagePath(filePath: unknown): ValidCaptionImage {
  if (typeof filePath !== "string") return rejectedImage("filePath 必须是 string");
  if (!fs.existsSync(filePath)) return rejectedImage("文件不存在");
  const metadata = fs.statSync(filePath);
  if (!metadata.isFile()) return rejectedImage("不是文件");
  const suffix = path.extname(filePath).toLowerCase();
  if (!isImageExt(suffix)) return rejectedImage("只支持图片文件");
  if (metadata.size > IMAGE_CAPTION_MAX_BYTES) return rejectedImage("图片不能超过 20MB");
  const bytes = fs.readFileSync(filePath);
  return { ok: true, filePath, buffer: bytes, mime: getMimeFromExt(suffix) };
}

export async function captionImageSafe(
  imagePath: unknown,
  prompt: string,
  config: VisionConfig,
): Promise<{ ok: true; caption: string } | { ok: false; error: string }> {
  // File-system failures keep their existing propagation semantics.
  const image = validateCaptionImagePath(imagePath);
  if (!image.ok) return rejectedImage(image.error);
  try {
    const description = await captionImage(
      { base64: image.buffer.toString("base64"), mime: image.mime }, prompt, config,
    );
    return description.startsWith("[错误")
      ? rejectedImage(description)
      : { ok: true, caption: description };
  } catch (failure: any) {
    return rejectedImage(failure?.message || String(failure));
  }
}
