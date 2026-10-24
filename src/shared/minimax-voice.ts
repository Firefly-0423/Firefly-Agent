// MiniMax 服务端错误码 -> 面向用户的中文说明（含鉴权、额度、审核、音色复刻）
const KNOWN_ERRORS = new Map<number, string>([
  [1000, "服务暂时出现未知问题，请稍后重试。"],
  [1001, "请求超时，请稍后重试。"],
  [1002, "请求过于频繁，请稍后再试。"],
  [1004, "API Key 无效或未授权，请检查 MiniMax API Key。"],
  [1008, "账户余额不足，请前往 MiniMax 检查余额。"],
  [1024, "MiniMax 内部错误，请稍后重试。"],
  [1026, "输入内容未通过平台审核，请调整后重试。"],
  [1027, "输出内容未通过平台审核，请调整后重试。"],
  [1033, "MiniMax 的下游服务暂时异常，请稍后重试。"],
  [1039, "请求内容超过 Token 限制，请缩短文本后重试。"],
  [1041, "账号连接数达到限制，请联系 MiniMax 支持。"],
  [1042, "输入包含过多不可见或非法字符，请检查文本。"],
  [1043, "语音与校验文本相似度不足，请检查音频和文本是否匹配。"],
  [1044, "示例音频与示例文本相似度不足，请检查两者是否匹配。"],
  [2013, "请求参数不正确，请检查填写内容后重试。"],
  [2037, "复刻音频时长不符合要求；需在 10 秒到 5 分钟之间。"],
  [2038, "当前账号未开通音色复刻；请先完成 MiniMax 个人或企业认证。"],
  [2039, "音色 ID 已存在。请使用一个新的音色 ID 后再试。"],
  [2042, "当前 API Key 无权使用这个音色 ID，请确认创建账号。"],
  [2045, "请求频率变化过快，请稍等后再试。"],
  [2048, "示例音频过长；时长必须小于 8 秒。"],
  [2049, "API Key 无效，请检查后重试。"],
  [2056, "当前语音资源额度不足，请等待额度释放后再试。"],
  [20132, "复刻音频或音色 ID 参数不正确，请检查后重试。"],
]);

const stripTrailingPeriod = (text: string): string => text.replace(/。$/, "");

/** 按 MiniMax 官方规则检查自定义音色 ID；合法返回 null，否则返回原因。 */
export function validateMiniMaxVoiceId(voiceId: string): string | null {
  const { length } = voiceId;
  if (length < 8 || length > 256) return "音色 ID 长度需在 8 到 256 个字符之间。";
  if (!/^[A-Za-z]/.test(voiceId)) return "音色 ID 必须以英文字母开头。";
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(voiceId)) return "音色 ID 仅能包含英文字母、数字、- 或 _。";
  if (/[-_]$/.test(voiceId)) return "音色 ID 末尾不能是 - 或 _。";
  return null;
}

/** 生成预填用的音色 ID（UTC 时间戳 + 6 位随机串），用户可自行改名。 */
export function createUniqueMiniMaxVoiceId(random = Math.random, now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const day = `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  const time = `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  const salt = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return `firefly-voice-${day}-${time}-${salt}`;
}

/** 把 MiniMax 返回的错误码整理成可直接展示的中文提示。 */
export function buildMiniMaxErrorMessage(code?: number, statusMessage?: string, traceId?: string): string {
  if (code === undefined) {
    const reason = statusMessage || "MiniMax 没有返回有效响应，请稍后重试。";
    return `MiniMax 请求失败：${reason}${traceId ? `（trace_id ${traceId}）` : ""}`;
  }
  const tail = `（错误码 ${code}${traceId ? `；trace_id ${traceId}` : ""}）。`;
  const known = KNOWN_ERRORS.get(code);
  if (known) return stripTrailingPeriod(known) + tail;
  return `MiniMax 请求失败：${stripTrailingPeriod(statusMessage || "请稍后重试。")}${tail}`;
}
