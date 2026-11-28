const streamRejection = /(?:stream(?:ing)?[^\r\n]{0,40}(?:not supported|unsupported|must be false|disabled|unavailable)|(?:not supported|unsupported)[^\r\n]{0,40}stream(?:ing)?|only non[- ]?stream|不支持.{0,12}流式|流式.{0,12}不支持)/i;

export function isExplicitStreamUnsupported(error: unknown): boolean {
  const visited = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !visited.has(cause);) {
    visited.add(cause);
    const detail = cause as { status?: unknown; message?: unknown; cause?: unknown };
    const httpStatus = typeof detail.status === "number" ? detail.status : 0;
    const description = typeof detail.message === "string" ? detail.message : "";
    // 保留兼容接口仅返回拒绝文本时的回退行为。
    if (((httpStatus === 400 || httpStatus === 422) && streamRejection.test(description))
      || streamRejection.test(description)) return true;
    cause = detail.cause;
  }
  return false;
}
