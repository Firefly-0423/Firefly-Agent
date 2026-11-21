/** 清单校验用的最小 SemVer 实现：只覆盖版本号解析和 npm 风格范围（^ ~ 比较符 x 通配 ||）。 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function parseSemVer(text: string): SemVer | null {
  const m = SEMVER.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split(".") : [] };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

interface Comparator {
  op: ">" | ">=" | "<" | "<=" | "=";
  version: SemVer;
}

export type RangeSet = Comparator[];

const PART = String.raw`(0|[1-9]\d*|x|X|\*)`;
const PARTIAL = new RegExp(`^v?${PART}(?:\\.${PART}(?:\\.${PART}(?:-([0-9a-zA-Z.-]+))?)?)?$`);

function isWild(part: string | undefined): boolean {
  return part === undefined || part === "x" || part === "X" || part === "*";
}

function ver(major: number, minor: number, patch: number, prerelease: string[] = []): SemVer {
  return { major, minor, patch, prerelease };
}

/** 把一个片段（如 ^1.2.0、~1.2、>=1.0.0、1.x）展开为基础比较符；格式不对返回 null。 */
function expandToken(token: string): Comparator[] | null {
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "";
  const p = PARTIAL.exec(m[2]);
  if (!p) return null;
  const [, a, b, c, pre] = p;
  if (isWild(a)) {
    // * / x：任意版本；带运算符的通配没有意义
    return op === "" || op === "=" ? [] : null;
  }
  // 1.x.3 这种“中间通配、后面又给值”不合法
  if (isWild(b) && c !== undefined && !isWild(c)) return null;
  const major = Number(a);
  const minor = isWild(b) ? undefined : Number(b);
  const patch = isWild(c) ? undefined : Number(c);
  const lo = ver(major, minor ?? 0, patch ?? 0, pre ? pre.split(".") : []);
  const nextMinor = ver(major, (minor ?? 0) + 1, 0);
  const nextMajor = ver(major + 1, 0, 0);

  switch (op) {
    case "^": {
      let upper: SemVer;
      if (minor === undefined) upper = nextMajor;
      else if (major > 0) upper = nextMajor;
      else if (minor > 0 || patch === undefined) upper = nextMinor;
      else upper = ver(0, 0, (patch ?? 0) + 1);
      return [{ op: ">=", version: lo }, { op: "<", version: upper }];
    }
    case "~":
      return [{ op: ">=", version: lo }, { op: "<", version: minor === undefined ? nextMajor : nextMinor }];
    case ">=":
      return [{ op: ">=", version: lo }];
    case "<":
      return [{ op: "<", version: lo }];
    case "<=":
      return patch === undefined
        ? [{ op: "<", version: minor === undefined ? nextMajor : nextMinor }]
        : [{ op: "<=", version: lo }];
    case ">":
      return patch === undefined
        ? [{ op: ">=", version: minor === undefined ? nextMajor : nextMinor }]
        : [{ op: ">", version: lo }];
    default:
      return patch === undefined
        ? [{ op: ">=", version: lo }, { op: "<", version: minor === undefined ? nextMajor : nextMinor }]
        : [{ op: "=", version: lo }];
  }
}

/** 解析范围；任何一段无法识别就返回 null（调用方报 invalid_sdk_range）。 */
export function parseRange(text: string): RangeSet[] | null {
  if (text.trim() === "") return null;
  const sets: RangeSet[] = [];
  for (const alternative of text.split("||")) {
    // 把 ">= 1.0.0" 这种运算符与版本之间的空格并回去
    const normalized = alternative.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1");
    if (normalized === "") return null;
    const set: RangeSet = [];
    for (const token of normalized.split(/\s+/)) {
      const expanded = expandToken(token);
      if (!expanded) return null;
      set.push(...expanded);
    }
    sets.push(set);
  }
  return sets;
}

function matches(c: Comparator, version: SemVer): boolean {
  const cmp = compareSemVer(version, c.version);
  switch (c.op) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    default:
      return cmp === 0;
  }
}

/** npm 规则：预发布版本只满足“某个比较符与它同为 major.minor.patch 且带预发布”的范围。 */
export function satisfiesRange(version: SemVer, sets: RangeSet[]): boolean {
  return sets.some((set) => {
    if (!set.every((c) => matches(c, version))) return false;
    if (version.prerelease.length === 0) return true;
    return set.some(
      (c) =>
        c.version.prerelease.length > 0 &&
        c.version.major === version.major &&
        c.version.minor === version.minor &&
        c.version.patch === version.patch,
    );
  });
}
