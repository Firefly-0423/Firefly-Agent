// 用户可选时区的白名单：设置页只展示这里的条目；保存时也只接受这里的 value，
// 空串、非法值或不在名单里的一律回退到 Asia/Shanghai。
// label 的展示形式为"城市时间（UTC±hh:mm）"，value 是 IANA 时区名；偏移按标准时间计算，不随夏令时变化。
// 主进程的 resolveChatContextTimezone 只借助 Intl 校验 IANA 名，本身没有另外的列表，
// 所以新增条目不必改主进程，但 value 必须是 Intl 能识别的 Area/City 形式。
// 凡是主进程的格式化逻辑，都必须先经过 resolveChatContextTimezone 校验，才能把 profile.timezone 交给 Intl。

export type TimezoneOption = {
  label: string;
  value: string;
};

// [IANA 名, 城市名, 标准时间偏移] —— label 由它们拼出
const TIMEZONE_ROWS: ReadonlyArray<readonly [value: string, city: string, offset: string]> = [
  ["Asia/Shanghai", "北京", "UTC+08:00"],
  ["Asia/Tokyo", "东京", "UTC+09:00"],
  ["Asia/Taipei", "台北", "UTC+08:00"],
  ["Asia/Seoul", "首尔", "UTC+09:00"],
  ["Asia/Hong_Kong", "香港", "UTC+08:00"],
  ["Asia/Singapore", "新加坡", "UTC+08:00"],
  ["Asia/Kolkata", "印度", "UTC+05:30"],
  ["Asia/Dubai", "迪拜", "UTC+04:00"],
  ["Europe/London", "伦敦", "UTC+00:00"],
  ["Europe/Paris", "巴黎", "UTC+01:00"],
  ["Europe/Berlin", "柏林", "UTC+01:00"],
  ["Europe/Moscow", "莫斯科", "UTC+03:00"],
  ["America/New_York", "纽约", "UTC-05:00"],
  ["America/Chicago", "芝加哥", "UTC-06:00"],
  ["America/Los_Angeles", "洛杉矶", "UTC-08:00"],
  ["America/Sao_Paulo", "圣保罗", "UTC-03:00"],
  ["Pacific/Honolulu", "檀香山", "UTC-10:00"],
  ["Australia/Sydney", "悉尼", "UTC+10:00"],
  ["Pacific/Auckland", "奥克兰", "UTC+12:00"],
];

export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = TIMEZONE_ROWS.map(([value, city, offset]) => ({
  label: `${city}时间（${offset}）`,
  value,
}));

/** 读取时的兜底时区：空串、非法值、不在白名单里，统一使用它。 */
export const FALLBACK_TIMEZONE = "Asia/Shanghai";

/** 把任意输入规范成白名单中的时区 value；无法识别时返回兜底时区。 */
export function normalizeTimezoneOptionValue(raw: string | null | undefined): string {
  const candidate = (raw ?? "").trim();
  if (candidate === "") return FALLBACK_TIMEZONE;
  const allowed = TIMEZONE_OPTIONS.some((option) => option.value === candidate);
  return allowed ? candidate : FALLBACK_TIMEZONE;
}