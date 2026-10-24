// 仅解析设置字段支持的数字与命令格式。
export function parsePositiveIntOrThrow(input: string, th: any) {
  const decimalOnly = /^[0-9]+$/.test(input);
  if (!decimalOnly) throw th;
  if (isNaN(input as any)) throw th;

  const integer = parseInt(input);
  if (Number.isNaN(integer) || integer <= 0) throw th;
  return integer;
}

export function parseCommandLine(input: string): { command: string; args: string[] } {
  const source = input.trim();
  if (source.length === 0) return { command: "", args: [] };

  const tokens: string[] = [];
  let token = "";
  let delimiter: string | null = null;
  for (const character of source) {
    if (delimiter !== null) {
      if (character === delimiter) delimiter = null;
      else token += character;
      continue;
    }
    switch (character) {
      case '"':
      case "'":
        delimiter = character;
        break;
      case " ":
        if (token.length > 0) {
          tokens.push(token);
          token = "";
        }
        break;
      default:
        token += character;
    }
  }
  // 忽略空引号参数；保留命令内部的制表符。
  if (token.length > 0) tokens.push(token);
  return { command: tokens[0] || "", args: tokens.slice(1) };
}
