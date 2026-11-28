export interface KeyValidationResult {
  diagnostics: { length: number; trimmed: boolean; hasNonAscii: boolean; hasControlChars: boolean };
  error?: string;
  normalized: string;
  valid: boolean;
}

export const BUILTIN_SEARCH_TOOL_ID = "web_search";
export const MINIMAX_SEARCH_TOOL_PREFIX = "minimax-web-search-";
export type SearchBackend = "off" | "bocha" | "tavily" | "minimax" | "anySearch";

export function validateSearchApiKey(rawKey: string, label: string): KeyValidationResult {
  const lengthBefore = rawKey.length;
  const clean = rawKey.trim();
  const wasTrimmed = clean.length !== lengthBefore;
  const outsideAscii = /[^\x20-\x7E]/.test(clean);
  const control = /[\x00-\x1F\x7F]/.test(clean);
  const details = { length: clean.length, trimmed: wasTrimmed, hasNonAscii: outsideAscii, hasControlChars: control };
  let reason: string;
  if (clean.length === 0) reason = `${label}不能为空`;
  else if (control) reason = `${label}包含控制字符，请重新输入`;
  else if (outsideAscii) reason = `${label}包含非 ASCII 字符，请确认是否复制了多余内容`;
  else return { valid: true, normalized: clean, diagnostics: details };
  return { valid: false, normalized: "", error: reason, diagnostics: details };
}

export function shouldExposeSearchTool(toolId: string, activeBackend: SearchBackend): boolean {
  if (toolId === BUILTIN_SEARCH_TOOL_ID) {
    return ["bocha", "tavily", "anySearch"].includes(activeBackend);
  }
  return toolId.startsWith(MINIMAX_SEARCH_TOOL_PREFIX) ? activeBackend === "minimax" : true;
}

export function filterToolsBySearchBackend<T extends { id: string }>(tools: T[], activeBackend: SearchBackend): T[] {
  return tools.filter(({ id }) => shouldExposeSearchTool(id, activeBackend));
}
