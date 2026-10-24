/**
 * 插件版本号工具。
 * 接受完整 SemVer 2.0（主.次.修订，可带预发布号与 build 元数据），不允许前导零。
 * 市场端与安装端（loader）共用这一套规则，避免口径不一致。
 */

/** 完整 SemVer 2.0 语法，loader 与市场校验共用，不要在别处另写 */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** 是否为合法的插件版本号，如 "0.1.0"、"2.0.0-beta.1" */
export function isValidPluginVersion(v: string): boolean {
  return typeof v === "string" && SEMVER_PATTERN.test(v.trim());
}

interface ParsedVersion {
  numbers: number[];
  prerelease: string[];
}

/** 拆成三段数字与预发布标识符；build 元数据不参与比较。调用前须已通过合法性校验 */
function parse(v: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(v)!;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

const sign = (a: number | string, b: number | string): number => (a === b ? 0 : a > b ? 1 : -1);

/** 比较两个预发布标识符：纯数字按数值，其余按字典序，数字小于非数字 */
function comparePrereleaseId(x: string, y: string): number {
  const xIsNum = /^\d+$/.test(x);
  const yIsNum = /^\d+$/.test(y);
  if (xIsNum && yIsNum) return sign(Number(x), Number(y));
  if (xIsNum) return -1;
  if (yIsNum) return 1;
  return sign(x, y);
}

/** 按 SemVer 2.0 优先级比较，返回 1 / -1 / 0 */
function compare(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const c = sign(left.numbers[i], right.numbers[i]);
    if (c !== 0) return c;
  }

  // 核心相同：正式版高于预发布版
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;

  const shared = Math.min(leftPre.length, rightPre.length);
  for (let i = 0; i < shared; i += 1) {
    const c = comparePrereleaseId(leftPre[i], rightPre[i]);
    if (c !== 0) return c;
  }
  // 前缀完全相同时，标识符更多者更大
  return sign(leftPre.length, rightPre.length);
}

/**
 * candidate 是否严格高于 baseline（SemVer 2.0 优先级）。
 * 预发布号低于对应正式版，build 元数据不参与比较。
 * 任一版本非法时直接返回 false，调用方应先自行校验。
 */
export function isNewerVersion(candidate: string, baseline: string): boolean {
  if (!isValidPluginVersion(candidate) || !isValidPluginVersion(baseline)) return false;
  return compare(candidate.trim(), baseline.trim()) > 0;
}
