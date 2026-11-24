/**
 * 1.2.0 清单的纯数据校验（规格 §4 校验规则 1–8 中不需要文件系统的部分）。
 * 不抛异常：任何输入都返回错误列表，每条带稳定的 code 和 JSON Pointer 路径。
 * 文件系统相关的检查（文件存在、符号链接越界、.node 文件）在 src/plugins/v2/package。
 */
import { parseRange, parseSemVer, satisfiesRange } from "./semver";
import {
  LEGACY_MANIFEST_KEYS,
  MANIFEST_KEYS,
  MANIFEST_SCHEMA_VERSION,
  PLUGIN_CONTEXT_MODES,
  PLUGIN_PERMISSIONS,
  PLUGIN_PLATFORMS,
  PLUGIN_RUN_SOURCES,
  PLUGIN_TOOL_MODES,
  PLUGIN_TOOL_RISKS,
  type ManifestError,
  type ManifestErrorCode,
  type PluginManifestV1,
} from "./types";

export interface ValidateManifestOptions {
  /** 当前宿主（Firefly 应用）版本，用来判断清单的 sdk 范围是否满足。 */
  hostVersion: string;
}

export type ValidateManifestResult =
  | { ok: true; manifest: PluginManifestV1; errors: [] }
  | { ok: false; manifest?: undefined; errors: ManifestError[] };

const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;
const ID_MIN = 6;
const ID_MAX = 64;
const ENTRY_EXTENSIONS = [".mjs", ".cjs"];

export const LEGACY_MANIFEST_MESSAGE = "这是 0.x 插件，1.2.0 不再支持";

/** 判断包内相对路径的写法：绝对路径、盘符、UNC、含 `..` 段、空串或含 NUL 都不行。返回出错码，合法返回 null。 */
export function checkRelativePathShape(value: string): "path_absolute" | "path_traversal" | "invalid_path" | null {
  if (value.trim() === "" || value.includes("\0")) return "invalid_path";
  // 盘符（C:foo 也算）、UNC（\\host、//host）、以及两种分隔符开头的绝对路径
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("\\") || value.startsWith("/")) return "path_absolute";
  if (value.split(/[\\/]+/).includes("..")) return "path_traversal";
  return null;
}

class Collector {
  readonly errors: ManifestError[] = [];

  add(code: ManifestErrorCode, path: string, message: string): void {
    this.errors.push({ code, path, message });
  }
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** 检查对象只含已知字段。 */
function rejectUnknownKeys(c: Collector, obj: Obj, known: Record<string, true>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(known, key)) c.add("unknown_field", `${path}/${key}`, `未知字段 ${key}`);
  }
}

/** 读非空字符串；缺失（必填时）或类型不对时记错并返回 undefined。 */
function readString(c: Collector, obj: Obj, key: string, path: string, required: boolean): string | undefined {
  const value = obj[key];
  const at = `${path}/${key}`;
  if (value === undefined) {
    if (required) c.add("required", at, `缺少必填字段 ${key}`);
    return undefined;
  }
  if (typeof value !== "string") {
    c.add("invalid_type", at, `${key} 必须是字符串，实际是 ${describe(value)}`);
    return undefined;
  }
  if (value.trim() === "") {
    c.add("invalid_value", at, `${key} 不能为空`);
    return undefined;
  }
  return value;
}

function readArray(c: Collector, obj: Obj, key: string, path: string, required: boolean): unknown[] | undefined {
  const value = obj[key];
  const at = `${path}/${key}`;
  if (value === undefined) {
    if (required) c.add("required", at, `缺少必填字段 ${key}`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    c.add("invalid_type", at, `${key} 必须是数组，实际是 ${describe(value)}`);
    return undefined;
  }
  return value;
}

function readObject(c: Collector, obj: Obj, key: string, path: string): Obj | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    c.add("invalid_type", `${path}/${key}`, `${key} 必须是对象，实际是 ${describe(value)}`);
    return undefined;
  }
  return value;
}

/** 读枚举数组：每个元素用 classify 给出出错码；要求至少一项时空数组报 emptyCode。 */
function readEnumList(
  c: Collector,
  obj: Obj,
  key: string,
  path: string,
  options: {
    allowed: readonly string[];
    required: boolean;
    nonEmpty: boolean;
    emptyCode: ManifestErrorCode;
    invalidCode: ManifestErrorCode;
    /** 个别取值要给更具体的错误码，如 risk 里的 safe。 */
    special?: Record<string, { code: ManifestErrorCode; message: string }>;
  },
): void {
  const list = readArray(c, obj, key, path, options.required);
  if (!list) return;
  const at = `${path}/${key}`;
  if (options.nonEmpty && list.length === 0) c.add(options.emptyCode, at, `${key} 至少要有一项`);
  list.forEach((item, index) => {
    const itemPath = `${at}/${index}`;
    if (typeof item !== "string") {
      c.add("invalid_type", itemPath, `${key} 的元素必须是字符串，实际是 ${describe(item)}`);
      return;
    }
    const special = options.special?.[item];
    if (special) c.add(special.code, itemPath, special.message);
    else if (!options.allowed.includes(item)) c.add(options.invalidCode, itemPath, `${key} 不接受 ${JSON.stringify(item)}，可选 ${options.allowed.join("、")}`);
  });
}

/** main / icon / ui.*.entry：包内相对路径的写法检查，main 另要求 .mjs / .cjs。 */
function checkPathField(c: Collector, value: string | undefined, path: string, isMain: boolean): void {
  if (value === undefined) return;
  const shape = checkRelativePathShape(value);
  if (shape === "path_absolute") c.add(shape, path, "必须是包内相对路径，不能是绝对路径、盘符或 UNC 路径");
  else if (shape === "path_traversal") c.add(shape, path, "路径不能含 .. ，不得逃出包根目录");
  else if (shape) c.add(shape, path, "路径不合法");
  else if (isMain && !ENTRY_EXTENSIONS.some((ext) => value.endsWith(ext))) {
    c.add("main_extension", path, `main 必须是 ${ENTRY_EXTENSIONS.join(" 或 ")} 文件`);
  }
}

/** 同一类 id 在清单内不能重复；记在后出现那一项的 idField 上。 */
function checkDuplicates(c: Collector, items: unknown[] | undefined, listPath: string, field: string, label: string): void {
  if (!items) return;
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!isObject(item)) return;
    const value = item[field];
    if (typeof value !== "string") return;
    if (seen.has(value)) c.add("duplicate_id", `${listPath}/${index}/${field}`, `${label} ${JSON.stringify(value)} 重复声明`);
    seen.add(value);
  });
}

function validateTools(c: Collector, root: Obj): void {
  const tools = readArray(c, root, "tools", "", false);
  if (!tools) return;
  tools.forEach((tool, index) => {
    const path = `/tools/${index}`;
    if (!isObject(tool)) return c.add("invalid_type", path, `tools 的元素必须是对象，实际是 ${describe(tool)}`);
    rejectUnknownKeys(c, tool, MANIFEST_KEYS.tool, path);
    readString(c, tool, "name", path, true);
    readString(c, tool, "title", path, true);
    readEnumList(c, tool, "risk", path, {
      allowed: PLUGIN_TOOL_RISKS,
      required: true,
      nonEmpty: true,
      emptyCode: "risk_empty",
      invalidCode: "risk_invalid",
      special: { safe: { code: "risk_safe_forbidden", message: "插件工具不允许声明 safe，请声明真实的风险" } },
    });
    readEnumList(c, tool, "modes", path, {
      allowed: PLUGIN_TOOL_MODES,
      required: true,
      nonEmpty: true,
      emptyCode: "modes_empty",
      invalidCode: "mode_invalid",
    });
  });
  checkDuplicates(c, tools, "/tools", "name", "工具名");
}

function validateContexts(c: Collector, root: Obj): void {
  const contexts = readArray(c, root, "context", "", false);
  if (!contexts) return;
  contexts.forEach((item, index) => {
    const path = `/context/${index}`;
    if (!isObject(item)) return c.add("invalid_type", path, `context 的元素必须是对象，实际是 ${describe(item)}`);
    rejectUnknownKeys(c, item, MANIFEST_KEYS.context, path);
    readString(c, item, "id", path, true);
    readString(c, item, "title", path, true);
    readEnumList(c, item, "modes", path, {
      allowed: PLUGIN_CONTEXT_MODES,
      required: true,
      nonEmpty: true,
      emptyCode: "modes_empty",
      invalidCode: "mode_invalid",
    });
    readEnumList(c, item, "sources", path, {
      allowed: PLUGIN_RUN_SOURCES,
      required: true,
      nonEmpty: true,
      emptyCode: "source_invalid",
      invalidCode: "source_invalid",
    });
  });
  checkDuplicates(c, contexts, "/context", "id", "上下文 id");
}

function validateChannels(c: Collector, root: Obj): void {
  const channels = readArray(c, root, "channels", "", false);
  if (!channels) return;
  channels.forEach((item, index) => {
    const path = `/channels/${index}`;
    if (!isObject(item)) return c.add("invalid_type", path, `channels 的元素必须是对象，实际是 ${describe(item)}`);
    rejectUnknownKeys(c, item, MANIFEST_KEYS.channel, path);
    readString(c, item, "id", path, true);
    readString(c, item, "title", path, true);
  });
  checkDuplicates(c, channels, "/channels", "id", "渠道 id");
}

function readSize(c: Collector, obj: Obj, key: "width" | "height", path: string): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "number") c.add("invalid_type", `${path}/${key}`, `${key} 必须是数字，实际是 ${describe(value)}`);
  else if (!Number.isInteger(value) || value <= 0) c.add("invalid_value", `${path}/${key}`, `${key} 必须是正整数`);
}

function validateUi(c: Collector, root: Obj): void {
  const ui = readObject(c, root, "ui", "");
  if (!ui) return;
  rejectUnknownKeys(c, ui, MANIFEST_KEYS.ui, "/ui");

  const settings = readObject(c, ui, "settings", "/ui");
  if (settings) {
    rejectUnknownKeys(c, settings, MANIFEST_KEYS.settings, "/ui/settings");
    checkPathField(c, readString(c, settings, "entry", "/ui/settings", true), "/ui/settings/entry", false);
    readString(c, settings, "title", "/ui/settings", true);
  }

  const windows = readArray(c, ui, "windows", "/ui", false);
  if (!windows) return;
  windows.forEach((item, index) => {
    const path = `/ui/windows/${index}`;
    if (!isObject(item)) return c.add("invalid_type", path, `windows 的元素必须是对象，实际是 ${describe(item)}`);
    rejectUnknownKeys(c, item, MANIFEST_KEYS.window, path);
    readString(c, item, "id", path, true);
    checkPathField(c, readString(c, item, "entry", path, true), `${path}/entry`, false);
    readString(c, item, "title", path, true);
    readSize(c, item, "width", path);
    readSize(c, item, "height", path);
  });
  checkDuplicates(c, windows, "/ui/windows", "id", "窗口 id");
}

function validateSdkRange(c: Collector, sdk: string | undefined, hostVersion: string): void {
  if (sdk === undefined) return;
  const range = parseRange(sdk);
  if (!range) return c.add("invalid_sdk_range", "/sdk", `sdk 不是有效的版本范围: ${JSON.stringify(sdk)}`);
  const host = parseSemVer(hostVersion);
  // 宿主版本由调用方提供；它自己不合法属于调用错误，不应让清单背锅，按不满足处理会误导，所以抛出
  if (!host) throw new TypeError(`hostVersion 不是有效的 SemVer: ${JSON.stringify(hostVersion)}`);
  if (!satisfiesRange(host, range)) {
    c.add("sdk_unsatisfied", "/sdk", `当前 Firefly ${hostVersion} 不满足插件要求的 sdk ${sdk}`);
  }
}

export function validateManifest(input: unknown, options: ValidateManifestOptions): ValidateManifestResult {
  const c = new Collector();
  if (!isObject(input)) {
    c.add("manifest_not_object", "", `清单必须是 JSON 对象，实际是 ${describe(input)}`);
    return { ok: false, errors: c.errors };
  }

  // 规则 1：0.x 清单一律拒绝，不再检查其余字段，避免刷出一堆无意义的错误
  if (LEGACY_MANIFEST_KEYS.some((key) => Object.hasOwn(input, key))) {
    c.add("legacy_manifest", "", LEGACY_MANIFEST_MESSAGE);
    return { ok: false, errors: c.errors };
  }
  if (input.schemaVersion === undefined) c.add("required", "/schemaVersion", "缺少必填字段 schemaVersion");
  else if (input.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    c.add("schema_version_unsupported", "/schemaVersion", `schemaVersion 必须是 ${MANIFEST_SCHEMA_VERSION}`);
  }

  rejectUnknownKeys(c, input, MANIFEST_KEYS.root, "");

  // 规则 2：id、version、sdk
  const id = readString(c, input, "id", "", true);
  if (id !== undefined && (!ID_PATTERN.test(id) || id.length < ID_MIN || id.length > ID_MAX)) {
    c.add("invalid_id", "/id", `id 必须是 ${ID_MIN}–${ID_MAX} 字符的反向域名（如 dev.firefly.weather）`);
  }
  readString(c, input, "name", "", true);
  const version = readString(c, input, "version", "", true);
  if (version !== undefined && !parseSemVer(version)) c.add("invalid_version", "/version", `version 必须是 SemVer，实际是 ${JSON.stringify(version)}`);
  validateSdkRange(c, readString(c, input, "sdk", "", true), options.hostVersion);

  readString(c, input, "description", "", false);
  readString(c, input, "license", "", false);

  const author = readObject(c, input, "author", "");
  if (author) {
    rejectUnknownKeys(c, author, MANIFEST_KEYS.author, "/author");
    readString(c, author, "name", "/author", true);
    readString(c, author, "email", "/author", false);
    readString(c, author, "url", "/author", false);
  }

  // 规则 3 的写法部分：路径形状与 main 扩展名
  checkPathField(c, readString(c, input, "main", "", true), "/main", true);
  checkPathField(c, readString(c, input, "icon", "", false), "/icon", false);

  readEnumList(c, input, "platforms", "", {
    allowed: PLUGIN_PLATFORMS,
    required: false,
    nonEmpty: true,
    emptyCode: "platform_invalid",
    invalidCode: "platform_invalid",
  });
  if (input.native !== undefined && typeof input.native !== "boolean") {
    c.add("invalid_type", "/native", `native 必须是布尔值，实际是 ${describe(input.native)}`);
  }

  // 规则 5、6：工具风险与模式；规则 4 的静态闭合靠重复检查与运行时 ERR_UNDECLARED
  validateTools(c, input);
  validateContexts(c, input);
  validateChannels(c, input);

  // 规则 8
  readEnumList(c, input, "permissions", "", {
    allowed: PLUGIN_PERMISSIONS,
    required: false,
    nonEmpty: false,
    emptyCode: "permission_invalid",
    invalidCode: "permission_invalid",
  });
  validateUi(c, input);

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, manifest: input as unknown as PluginManifestV1, errors: [] };
}
