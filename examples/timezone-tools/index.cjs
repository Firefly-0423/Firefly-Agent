"use strict";

// Pure computation through the public Plugin API v1, using only the engine's built-in Intl and Date.
// Zone canonicalization is adapted from deepseek-harness packages/util/time
// (MIT, Copyright (c) 2026 DeepSeek); conversion is new Firefly code built on the same zone vocabulary.
const CANONICALIZE_ID = "timezone-tools_canonicalize";
const CONVERT_ID = "timezone-tools_convert";
const MAX_ZONE_CHARS = 100;
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;
const DAY_MS = 86_400_000;
// Strict profile from deepseek-harness: UTC or an IANA Area/Location-style identifier.
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;
let activeContext;

function canonicalZone(value) {
  if (value.length === 0 || value.length > MAX_ZONE_CHARS || value.trim() !== value
    || (value !== "UTC" && !IANA_TIME_ZONE.test(value))) return undefined;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return canonical === "UTC" || IANA_TIME_ZONE.test(canonical) ? canonical : undefined;
  } catch {
    // Intl rejects zone names the platform does not know.
    return undefined;
  }
}

/** Validates with the canonicalization profile but keeps the caller's spelling, so results echo the name that was asked for. */
function requireZone(value, name) {
  if (canonicalZone(value) === undefined) throw new Error(`${name} is not a valid zone: use UTC or an IANA Area/Location name such as Asia/Tokyo`);
  return value;
}

const formatters = new Map();
function formatterFor(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** UTC offset in effect at an instant, in milliseconds (local wall time minus UTC), at whole-second precision. */
function offsetAt(zone, utcMs) {
  const parts = {};
  for (const part of formatterFor(zone).formatToParts(new Date(utcMs))) parts[part.type] = Number(part.value);
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallMs - Math.floor(utcMs / 1000) * 1000;
}

function pad(number, width = 2) {
  return String(number).padStart(width, "0");
}

function formatOffset(offsetMs) {
  const sign = offsetMs < 0 ? "-" : "+";
  const total = Math.abs(offsetMs) / 1000;
  const seconds = total % 60;
  const text = `${sign}${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}`;
  return seconds ? `${text}:${pad(seconds)}` : text;
}

function describe(zone, utcMs) {
  const offset = offsetAt(zone, utcMs);
  return { zone, local: new Date(utcMs + offset).toISOString().slice(0, -1), offset: formatOffset(offset) };
}

function parseTime(text) {
  const match = ISO_TIME.exec(text);
  if (!match) throw new Error("time must be ISO 8601 date and time, for example 2026-03-08T12:00:00Z or 2026-03-08T12:00:00+09:00");
  const [, y, mo, d, h, mi, s = "0", fraction = "", designator] = match;
  const year = Number(y);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new Error(`year must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  const parts = [year, Number(mo), Number(d), Number(h), Number(mi), Number(s)];
  const wallMs = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], Number(fraction.slice(0, 3).padEnd(3, "0")));
  const check = new Date(wallMs);
  const real = check.getUTCFullYear() === parts[0] && check.getUTCMonth() === parts[1] - 1 && check.getUTCDate() === parts[2]
    && check.getUTCHours() === parts[3] && check.getUTCMinutes() === parts[4] && check.getUTCSeconds() === parts[5];
  if (!real) throw new Error("time does not name a real date and time");
  let offsetMs;
  if (designator === "Z") offsetMs = 0;
  else if (designator) {
    const digits = designator.replace(":", "");
    const hours = Number(digits.slice(1, 3));
    const minutes = Number(digits.slice(3, 5));
    if (hours > 23 || minutes > 59) throw new Error("UTC offset must be within +/-23:59");
    offsetMs = (digits[0] === "-" ? -1 : 1) * (hours * 3600 + minutes * 60) * 1000;
  }
  return { wallMs, offsetMs, display: text.slice(0, 19) };
}

/** Instants whose wall-clock reading in `zone` equals `wallMs`: none in a gap, two in a fold, otherwise one. */
function instantsForLocal(zone, wallMs) {
  const candidates = new Set();
  for (const probe of [wallMs - DAY_MS, wallMs + DAY_MS]) {
    const offset = offsetAt(zone, probe);
    const utcMs = wallMs - offset;
    if (offsetAt(zone, utcMs) === offset) candidates.add(utcMs);
  }
  return [...candidates].sort((a, b) => a - b);
}

function isoInstant(ms) {
  return new Date(ms).toISOString();
}

module.exports = {
  register(ctx) {
    if (activeContext) throw new Error("Time zone tools is already registered");
    ctx.registerTool({
      id: CANONICALIZE_ID,
      name: "时区名校验",
      description: "校验并规范化 IANA 时区名。只接受 UTC 或 Area/Location 形式（如 Asia/Shanghai），拒绝缩写（EST、GMT）、带空白的名称和平台不认识的名称；别名按本机 ICU 数据返回规范拼写。全部离线处理。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      inputSchema: {
        type: "object",
        properties: { zone: { type: "string", description: "时区名，例如 America/New_York 或 UTC" } },
        required: ["zone"],
      },
      async execute(args) {
        if (!args || typeof args.zone !== "string") throw new TypeError("zone must be a string");
        if (args.zone.length > MAX_ZONE_CHARS) throw new RangeError(`zone must be at most ${MAX_ZONE_CHARS} characters`);
        const canonical = canonicalZone(args.zone);
        return JSON.stringify(canonical === undefined ? { valid: false } : { valid: true, canonical });
      },
    });
    ctx.registerTool({
      id: CONVERT_ID,
      name: "时区换算",
      description: "把一个时间换算到目标时区。time 为带 Z 或 ±hh:mm 偏移的 ISO 8601 时间时表示确定的瞬间；不带偏移的本地时间必须同时给出 from 时区。夏令时空档中不存在的本地时间会报错；重复的本地时间取较早瞬间并标记 ambiguous。支持 1900–2200 年，精度到毫秒。全部离线处理。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "string", description: "ISO 8601 时间，例如 2026-03-08T12:00:00Z、2026-03-08T12:00:00+09:00，或不带偏移的 2026-03-08T12:00:00（需要 from）" },
          to: { type: "string", description: "目标时区，UTC 或 IANA Area/Location 名" },
          from: { type: "string", description: "time 不带偏移时用于解释本地时间的时区；time 已带偏移时不要提供" },
        },
        required: ["time", "to"],
      },
      async execute(args) {
        if (!args || typeof args.time !== "string" || typeof args.to !== "string") throw new TypeError("time and to must be strings");
        if (args.from !== undefined && typeof args.from !== "string") throw new TypeError("from must be a string");
        const target = requireZone(args.to, "to");
        const parsed = parseTime(args.time);
        const result = {};
        if (parsed.offsetMs !== undefined) {
          if (args.from !== undefined) throw new Error("time already has an offset; omit from");
          const utcMs = parsed.wallMs - parsed.offsetMs;
          result.instant = isoInstant(utcMs);
          result.to = describe(target, utcMs);
          return JSON.stringify(result);
        }
        if (args.from === undefined) throw new Error("time without an offset requires from, the zone of that local time");
        const source = requireZone(args.from, "from");
        const instants = instantsForLocal(source, parsed.wallMs);
        if (instants.length === 0) throw new Error(`local time ${parsed.display} does not exist in ${source} (daylight-saving gap)`);
        result.instant = isoInstant(instants[0]);
        if (instants.length > 1) {
          result.ambiguous = true;
          result.alternativeInstant = isoInstant(instants[1]);
        }
        result.from = describe(source, instants[0]);
        result.to = describe(target, instants[0]);
        return JSON.stringify(result);
      },
    });
    activeContext = ctx;
  },
  unregister() {
    if (!activeContext) return;
    const ctx = activeContext;
    activeContext = undefined;
    ctx.unregisterTool(CANONICALIZE_ID);
    ctx.unregisterTool(CONVERT_ID);
  },
};
