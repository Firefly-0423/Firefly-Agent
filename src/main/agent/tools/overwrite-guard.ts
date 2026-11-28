export const OVERWRITE_DROP_MIN_LINES = 50;
export const OVERWRITE_DROP_RATIO = 0.5;

export interface OverwriteDropDecision {
  blocked: boolean; oldLineCount: number; newLineCount: number; ratio: number;
}

function measureLines(value: string): number {
  if (!value) return 0;
  const parts = value.replace(/\r\n/g, "\n").split("\n");
  return parts.length - Number(parts.at(-1) === "");
}

export function checkOverwriteDrop(existingContent: string, newContent: string): OverwriteDropDecision {
  const previous = measureLines(existingContent);
  const incoming = measureLines(newContent);
  const fraction = previous > 0 ? incoming / previous : 1;
  return {
    blocked: previous >= OVERWRITE_DROP_MIN_LINES && fraction < OVERWRITE_DROP_RATIO,
    oldLineCount: previous,
    newLineCount: incoming,
    ratio: fraction,
  };
}

export function overwriteDropMessage(decision: OverwriteDropDecision): string {
  return `覆盖写被拒绝：原文件 ${decision.oldLineCount} 行，新内容仅 ${decision.newLineCount} 行（${Math.round(decision.ratio * 100)}%），` +
    "疑似模型输出被截断。\n" +
    "如需局部修改请改用 str_replace（内容锚点替换）；" +
    "确需整文件重写请用 str_replace（old_string = 原文件全文）或请求用户协助，不要直接覆盖。";
}
