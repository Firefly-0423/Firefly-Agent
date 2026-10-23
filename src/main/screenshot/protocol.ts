import * as path from "node:path";

export type ScreenshotMode = "clipboard-and-file" | "clipboard-only";

type InteractionPhase = "selecting" | "selected" | "committing";
type CaptureSize = { width: number; height: number };

export type HelperEvent =
  | { type: "error"; code: string; message: string; recoverable: boolean; requestId?: string | null }
  | { type: "cancelled"; reason: string; requestId: string }
  | ({
      type: "completed";
      requestId: string;
      fileName: string | null;
      mime: "image/png";
      clipboardWritten: boolean;
      hasAnnotations: boolean;
    } & CaptureSize)
  | ({ type: "capture-released"; requestId: string; clipboardWritten: boolean } & CaptureSize)
  | { type: "interaction-state"; state: InteractionPhase; requestId: string }
  | { type: "overlay-visible"; freezeDurationMs: number; requestId: string }
  | { type: "accepted"; requestId: string }
  | { type: "ready"; protocolVersion: number };

type LooseRecord = Record<string, unknown>;
type EventBuilder = (raw: LooseRecord) => HelperEvent;

/** 与 helper 生成的文件名保持一致：仅接受 UUID v4 形式的 png 名称。 */
const COMPLETED_FILE_NAME = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.png$/i;
const U32_UPPER_BOUND = 2 ** 32 - 1;

function reject(): never {
  throw new Error("INVALID_HELPER_EVENT");
}

function isLooseRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isOptionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isText(value);
}

function isCompletedFileName(value: unknown): value is string {
  return typeof value === "string" && COMPLETED_FILE_NAME.test(value);
}

function isU32(value: unknown, floor = 0): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= floor
    && value <= U32_UPPER_BOUND;
}

function takeRequestId(raw: LooseRecord): string {
  const id = raw.requestId;
  if (!isText(id)) return reject();
  return id;
}

const EVENT_BUILDERS = new Map<string, EventBuilder>([
  ["ready", (raw) => {
    if (!isU32(raw.protocolVersion, 1)) return reject();
    return { type: "ready", protocolVersion: raw.protocolVersion };
  }],
  ["accepted", (raw) => ({ type: "accepted", requestId: takeRequestId(raw) })],
  ["overlay-visible", (raw) => {
    const requestId = takeRequestId(raw);
    if (!isU32(raw.freezeDurationMs)) return reject();
    return { type: "overlay-visible", requestId, freezeDurationMs: raw.freezeDurationMs };
  }],
  ["interaction-state", (raw) => {
    const state = raw.state;
    if (state !== "selecting" && state !== "selected" && state !== "committing") return reject();
    return { type: "interaction-state", requestId: takeRequestId(raw), state };
  }],
  ["capture-released", (raw) => {
    if (typeof raw.clipboardWritten !== "boolean") return reject();
    if (!isU32(raw.width, 1) || !isU32(raw.height, 1)) return reject();
    return {
      type: "capture-released",
      requestId: takeRequestId(raw),
      clipboardWritten: raw.clipboardWritten,
      width: raw.width,
      height: raw.height,
    };
  }],
  ["completed", (raw) => {
    const { fileName, width, height, mime, clipboardWritten, hasAnnotations } = raw;
    if (fileName !== null && !isCompletedFileName(fileName)) return reject();
    if (!isU32(width, 1) || !isU32(height, 1)) return reject();
    if (mime !== "image/png") return reject();
    if (typeof clipboardWritten !== "boolean" || typeof hasAnnotations !== "boolean") return reject();
    return {
      type: "completed",
      requestId: takeRequestId(raw),
      fileName,
      width,
      height,
      mime: "image/png",
      clipboardWritten,
      hasAnnotations,
    };
  }],
  ["cancelled", (raw) => {
    if (!isText(raw.reason)) return reject();
    return { type: "cancelled", requestId: takeRequestId(raw), reason: raw.reason };
  }],
  ["error", (raw) => {
    if (!isText(raw.code) || !isText(raw.message) || typeof raw.recoverable !== "boolean") return reject();
    const requestId = raw.requestId;
    if (!isOptionalText(requestId)) return reject();
    return {
      type: "error",
      ...(requestId === undefined ? {} : { requestId }),
      code: raw.code,
      message: raw.message,
      recoverable: raw.recoverable,
    };
  }],
]);

/** 解析 helper stdout 的一行 JSON；任何结构或取值不合法都统一抛出 INVALID_HELPER_EVENT。 */
export function parseHelperEvent(line: string): HelperEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return reject();
  }
  if (!isLooseRecord(decoded) || typeof decoded.type !== "string") return reject();

  const build = EVENT_BUILDERS.get(decoded.type);
  return build ? build(decoded) : reject();
}

/** 把 helper 报告的文件名锚定到截图目录内，拒绝任何能逃逸目录的名称。 */
export function resolveCompletedFile(outputDirectory: string, fileName: string): string {
  const invalid = () => new Error("INVALID_SCREENSHOT_FILE_NAME");
  if (!COMPLETED_FILE_NAME.test(fileName)) throw invalid();

  const baseDirectory = path.resolve(outputDirectory);
  const target = path.resolve(baseDirectory, fileName);
  if (path.dirname(target) !== baseDirectory) throw invalid();
  return target;
}
