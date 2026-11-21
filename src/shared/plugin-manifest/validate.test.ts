import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import schema from "./manifest.schema.json";
import { LEGACY_MANIFEST_MESSAGE, MANIFEST_KEYS, PLUGIN_CONTEXT_MODES, PLUGIN_PERMISSIONS, PLUGIN_PLATFORMS, PLUGIN_RUN_SOURCES, PLUGIN_TOOL_MODES, PLUGIN_TOOL_RISKS, validateManifest } from "./index";

const HOST = "1.2.0";

/** 规格 §4 的完整示例，每个用例在它上面改一处。 */
function baseManifest(): Record<string, any> {
  return {
    schemaVersion: 1,
    id: "dev.firefly.weather",
    name: "天气查询",
    version: "1.0.0",
    sdk: "^1.2.0",
    description: "查询城市天气。",
    author: { name: "示例作者" },
    license: "MIT",
    main: "dist/index.mjs",
    icon: "assets/icon.png",
    platforms: ["win32"],
    native: false,
    tools: [{ name: "get_weather", title: "查询天气", risk: ["network"], modes: ["work", "code"] }],
    context: [{ id: "now_playing", title: "正在播放", modes: ["chat", "work"], sources: ["user", "schedule"] }],
    channels: [],
    permissions: ["model.generate", "secrets"],
    ui: {
      settings: { entry: "ui/settings.html", title: "天气设置" },
      windows: [{ id: "radar", entry: "ui/radar.html", title: "雷达图", width: 480, height: 360 }],
    },
  };
}

function errorsOf(input: unknown, hostVersion = HOST): Array<{ code: string; path: string }> {
  return validateManifest(input, { hostVersion }).errors.map(({ code, path }) => ({ code, path }));
}

function mutated(change: (m: Record<string, any>) => void): Record<string, any> {
  const m = baseManifest();
  change(m);
  return m;
}

describe("validateManifest: 规格示例与最小清单", () => {
  it("规格 §4 的完整示例通过，原样返回清单", () => {
    const input = baseManifest();
    const result = validateManifest(input, { hostVersion: HOST });
    expect(result).toEqual({ ok: true, manifest: input, errors: [] });
  });

  it("只含必填字段的最小清单通过", () => {
    const minimal = { schemaVersion: 1, id: "dev.firefly.min", name: "最小", version: "0.0.1", sdk: "^1.2.0", main: "index.cjs" };
    expect(errorsOf(minimal)).toEqual([]);
  });
});

describe("validateManifest: 规则 1 schemaVersion 与 0.x 清单", () => {
  const legacy = {
    id: "old-plugin",
    name: "旧插件",
    version: "0.1.0",
    apiVersion: 1,
    description: "x",
    author: "a",
    entry: "index.js",
  };

  it("0.x 清单被拒绝，只报一条 legacy_manifest 并带“不再支持”提示", () => {
    const result = validateManifest(legacy, { hostVersion: HOST });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ code: "legacy_manifest", path: "", message: LEGACY_MANIFEST_MESSAGE }]);
    expect(LEGACY_MANIFEST_MESSAGE).toContain("1.2.0 不再支持");
  });

  it.each(["apiVersion", "entry", "deps", "hooks", "settingsPanel", "settingsSection", "defaultEnabled"])(
    "1.2.0 清单里混入 0.x 字段 %s 也按 0.x 拒绝",
    (key) => {
      expect(errorsOf(mutated((m) => (m[key] = 1)))).toEqual([{ code: "legacy_manifest", path: "" }]);
    },
  );

  it.each<[string, unknown, Array<{ code: string; path: string }>]>([
    ["schemaVersion 为 1 通过", 1, []],
    ["schemaVersion 为 2 被拒绝", 2, [{ code: "schema_version_unsupported", path: "/schemaVersion" }]],
    ["schemaVersion 为字符串 \"1\" 被拒绝", "1", [{ code: "schema_version_unsupported", path: "/schemaVersion" }]],
    ["缺少 schemaVersion 被拒绝", undefined, [{ code: "required", path: "/schemaVersion" }]],
  ])("%s", (_name, value, expected) => {
    const m = mutated((x) => {
      if (value === undefined) delete x.schemaVersion;
      else x.schemaVersion = value;
    });
    expect(errorsOf(m)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["数组", []],
    ["字符串", "x"],
    ["数字", 3],
  ])("清单不是对象（%s）时返回 manifest_not_object，不抛异常", (_name, input) => {
    expect(errorsOf(input)).toEqual([{ code: "manifest_not_object", path: "" }]);
  });
});

describe("validateManifest: 规则 2 id、version、sdk", () => {
  it.each<[string, string, boolean]>([
    ["三段反向域名", "dev.firefly.weather", true],
    ["段内允许连字符", "com.example.my-plugin", true],
    ["恰好 6 字符", "a.b.cd", true],
    ["只有两段", "firefly.weather", false],
    ["少于 6 字符", "a.b.c", false],
    ["含大写", "Dev.firefly.weather", false],
    ["首段含连字符", "my-dev.firefly.weather", false],
    ["含下划线", "dev.firefly.my_plugin", false],
    ["含空格", "dev.firefly.my plugin", false],
    ["末尾多一个点", "dev.firefly.weather.", false],
  ])("id %s: %s", (_name, id, ok) => {
    expect(errorsOf(mutated((m) => (m.id = id)))).toEqual(ok ? [] : [{ code: "invalid_id", path: "/id" }]);
  });

  it("id 恰好 64 字符通过，65 字符被拒绝", () => {
    const at64 = `dev.firefly.${"a".repeat(64 - "dev.firefly.".length)}`;
    expect(at64).toHaveLength(64);
    expect(errorsOf(mutated((m) => (m.id = at64)))).toEqual([]);
    expect(errorsOf(mutated((m) => (m.id = `${at64}a`)))).toEqual([{ code: "invalid_id", path: "/id" }]);
  });

  it.each<[string, string, boolean]>([
    ["普通版本", "1.0.0", true],
    ["预发布", "1.2.0-beta.1", true],
    ["构建元数据", "1.0.0+build.5", true],
    ["缺补丁位", "1.0", false],
    ["带 v 前缀", "v1.0.0", false],
    ["前导零", "01.0.0", false],
    ["非数字", "latest", false],
  ])("version %s: %s", (_name, version, ok) => {
    expect(errorsOf(mutated((m) => (m.version = version)))).toEqual(ok ? [] : [{ code: "invalid_version", path: "/version" }]);
  });

  it.each<[string, string, string, Array<{ code: string; path: string }>]>([
    ["^1.2.0 满足 1.2.0", "^1.2.0", "1.2.0", []],
    ["^1.2.0 满足 1.9.3", "^1.2.0", "1.9.3", []],
    ["^1.2.0 不满足 1.1.9（低于下限）", "^1.2.0", "1.1.9", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
    ["^1.2.0 不满足 2.0.0（到达上限）", "^1.2.0", "2.0.0", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
    ["^1.2.0 不满足 0.2.1（0.x 宿主）", "^1.2.0", "0.2.1", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
    ["~1.2.0 不满足 1.3.0", "~1.2.0", "1.3.0", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
    [">=1.2.0 <1.4.0 满足 1.3.5", ">=1.2.0 <1.4.0", "1.3.5", []],
    [">= 1.2.0 < 1.4.0 允许运算符后有空格", ">= 1.2.0 < 1.4.0", "1.3.5", []],
    ["|| 任一分支满足即可", "^1.0.0 || ^2.0.0", "2.1.0", []],
    ["1.x 通配", "1.x", "1.2.0", []],
    ["精确版本不满足其他版本", "1.2.0", "1.2.1", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
    ["预发布宿主不满足不含预发布的范围", "^1.2.0", "1.2.0-beta.1", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
    ["预发布宿主满足同版本的预发布范围", "^1.2.0-beta.0", "1.2.0-beta.1", []],
    ["不是版本范围", "banana", "1.2.0", [{ code: "invalid_sdk_range", path: "/sdk" }]],
    ["空范围", " ", "1.2.0", [{ code: "invalid_value", path: "/sdk" }]],
    ["1.x.3 不合法", "1.x.3", "1.2.0", [{ code: "invalid_sdk_range", path: "/sdk" }]],
    ["范围里的构建元数据被忽略：^1.2.0+build.5", "^1.2.0+build.5", "1.2.0", []],
    ["范围里的构建元数据被忽略：>=1.2.0+build.5 <2.0.0", ">=1.2.0+build.5 <2.0.0", "1.2.0", []],
    ["构建元数据不影响上限", "^1.2.0+build.5", "2.0.0", [{ code: "sdk_unsatisfied", path: "/sdk" }]],
  ])("sdk 范围 %s", (_name, sdk, host, expected) => {
    expect(errorsOf(mutated((m) => (m.sdk = sdk)), host)).toEqual(expected);
  });

  it("宿主版本本身不是 SemVer 属于调用错误，抛 TypeError 而不是把错记在清单上", () => {
    expect(() => validateManifest(baseManifest(), { hostVersion: "one" })).toThrow(TypeError);
  });
});

describe("validateManifest: 规则 3 路径写法（main、icon、ui 入口）", () => {
  it.each<[string, string, string, string | null]>([
    ["main 正常相对路径", "/main", "dist/index.mjs", null],
    ["main 用反斜杠分隔", "/main", "dist\\index.cjs", null],
    ["main 含 ..", "/main", "../evil.mjs", "path_traversal"],
    ["main 中途 ..", "/main", "dist/../../evil.mjs", "path_traversal"],
    ["main 反斜杠 ..", "/main", "dist\\..\\..\\evil.mjs", "path_traversal"],
    ["main 绝对路径（POSIX）", "/main", "/etc/evil.mjs", "path_absolute"],
    ["main 盘符", "/main", "C:\\evil.mjs", "path_absolute"],
    ["main 盘符相对", "/main", "C:evil.mjs", "path_absolute"],
    ["main UNC 路径", "/main", "\\\\server\\share\\evil.mjs", "path_absolute"],
    ["main 双斜杠 UNC", "/main", "//server/share/evil.mjs", "path_absolute"],
    ["main 含 NUL", "/main", "dist/index.mjs\0.txt", "invalid_path"],
    ["main 扩展名 .js", "/main", "dist/index.js", "main_extension"],
    ["main 扩展名 .ts", "/main", "dist/index.ts", "main_extension"],
    ["main 没有扩展名", "/main", "dist/index", "main_extension"],
    ["icon 含 ..", "/icon", "../icon.png", "path_traversal"],
    ["icon 绝对路径", "/icon", "/icon.png", "path_absolute"],
    ["settings 入口含 ..", "/ui/settings/entry", "../x.html", "path_traversal"],
    ["窗口入口盘符", "/ui/windows/0/entry", "D:\\x.html", "path_absolute"],
  ])("%s", (_name, path, value, code) => {
    const m = mutated((x) => {
      const keys = path.split("/").slice(1);
      let target: any = x;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)!] = value;
    });
    expect(errorsOf(m)).toEqual(code ? [{ code, path }] : []);
  });
});

describe("validateManifest: 规则 5 tools[].risk", () => {
  it.each<[string, unknown, Array<{ code: string; path: string }>]>([
    ...PLUGIN_TOOL_RISKS.map((risk): [string, unknown, Array<{ code: string; path: string }>] => [`${risk} 通过`, [risk], []]),
    ["多项风险通过", ["fs-read", "network"], []],
    ["声明 safe 被拒绝", ["safe"], [{ code: "risk_safe_forbidden", path: "/tools/0/risk/0" }]],
    ["safe 混在合法风险后面也被拒绝，路径指向 safe", ["network", "safe"], [{ code: "risk_safe_forbidden", path: "/tools/0/risk/1" }]],
    ["空数组被拒绝", [], [{ code: "risk_empty", path: "/tools/0/risk" }]],
    ["未知风险被拒绝", ["root"], [{ code: "risk_invalid", path: "/tools/0/risk/0" }]],
    ["元素不是字符串", [1], [{ code: "invalid_type", path: "/tools/0/risk/0" }]],
    ["risk 不是数组", "network", [{ code: "invalid_type", path: "/tools/0/risk" }]],
    ["缺少 risk", undefined, [{ code: "required", path: "/tools/0/risk" }]],
  ])("%s", (_name, risk, expected) => {
    const m = mutated((x) => {
      if (risk === undefined) delete x.tools[0].risk;
      else x.tools[0].risk = risk;
    });
    expect(errorsOf(m)).toEqual(expected);
  });
});

describe("validateManifest: 规则 6 tools[].modes", () => {
  it.each<[string, unknown, Array<{ code: string; path: string }>]>([
    ...PLUGIN_TOOL_MODES.map((mode): [string, unknown, Array<{ code: string; path: string }>] => [`${mode} 通过`, [mode], []]),
    ["work 与 code 通过", ["work", "code"], []],
    ["chat 被拒绝（Chat 模式不挂插件工具）", ["chat"], [{ code: "mode_invalid", path: "/tools/0/modes/0" }]],
    ["合法值后混入 chat，路径指向 chat", ["work", "chat"], [{ code: "mode_invalid", path: "/tools/0/modes/1" }]],
    ["空数组被拒绝", [], [{ code: "modes_empty", path: "/tools/0/modes" }]],
    ["缺少 modes", undefined, [{ code: "required", path: "/tools/0/modes" }]],
  ])("%s", (_name, modes, expected) => {
    const m = mutated((x) => {
      if (modes === undefined) delete x.tools[0].modes;
      else x.tools[0].modes = modes;
    });
    expect(errorsOf(m)).toEqual(expected);
  });

  it.each<[string, unknown, Array<{ code: string; path: string }>]>([
    ...PLUGIN_CONTEXT_MODES.map((mode): [string, unknown, Array<{ code: string; path: string }>] => [`context 模式 ${mode} 通过`, [mode], []]),
    ["context 模式未知", ["plan"], [{ code: "mode_invalid", path: "/context/0/modes/0" }]],
  ])("%s", (_name, modes, expected) => {
    expect(errorsOf(mutated((x) => (x.context[0].modes = modes)))).toEqual(expected);
  });

  it.each<[string, unknown, Array<{ code: string; path: string }>]>([
    ...PLUGIN_RUN_SOURCES.map((s): [string, unknown, Array<{ code: string; path: string }>] => [`来源 ${s} 通过`, [s], []]),
    ["来源未知", ["email"], [{ code: "source_invalid", path: "/context/0/sources/0" }]],
    ["来源为空数组", [], [{ code: "source_invalid", path: "/context/0/sources" }]],
  ])("context %s", (_name, sources, expected) => {
    expect(errorsOf(mutated((x) => (x.context[0].sources = sources)))).toEqual(expected);
  });
});

describe("validateManifest: 规则 8 permissions", () => {
  it.each<[string, unknown, Array<{ code: string; path: string }>]>([
    ["规格列出的八项全部通过", [...PLUGIN_PERMISSIONS], []],
    ["空数组通过", [], []],
    ["未列出的权限被拒绝", ["fs.write"], [{ code: "permission_invalid", path: "/permissions/0" }]],
    ["tools 不是权限，由 tools 数组声明", ["tools"], [{ code: "permission_invalid", path: "/permissions/0" }]],
    ["context、channels 同理", ["context", "channels"], [
      { code: "permission_invalid", path: "/permissions/0" },
      { code: "permission_invalid", path: "/permissions/1" },
    ]],
    ["不是数组", "secrets", [{ code: "invalid_type", path: "/permissions" }]],
  ])("%s", (_name, permissions, expected) => {
    expect(errorsOf(mutated((x) => (x.permissions = permissions)))).toEqual(expected);
  });
});

describe("validateManifest: 规则 4 重复 id（静态闭合的清单侧）", () => {
  const tool = (name: string) => ({ name, title: name, risk: ["network"], modes: ["work"] });
  it.each<[string, (m: Record<string, any>) => void, Array<{ code: string; path: string }>]>([
    ["工具名不重复通过", (m) => (m.tools = [tool("a"), tool("b")]), []],
    ["工具名重复，错误记在后出现的那项", (m) => (m.tools = [tool("a"), tool("b"), tool("a")]), [{ code: "duplicate_id", path: "/tools/2/name" }]],
    [
      "上下文 id 重复",
      (m) => {
        const c = { id: "ctx", title: "t", modes: ["chat"], sources: ["user"] };
        m.context = [c, { ...c }];
      },
      [{ code: "duplicate_id", path: "/context/1/id" }],
    ],
    [
      "渠道 id 重复",
      (m) => (m.channels = [{ id: "tg", title: "a" }, { id: "tg", title: "b" }]),
      [{ code: "duplicate_id", path: "/channels/1/id" }],
    ],
    [
      "窗口 id 重复",
      (m) => (m.ui.windows = [{ id: "w", entry: "a.html", title: "a" }, { id: "w", entry: "b.html", title: "b" }]),
      [{ code: "duplicate_id", path: "/ui/windows/1/id" }],
    ],
    [
      "不同类别可以用同一个标识（工具与上下文互不冲突）",
      (m) => {
        m.tools = [tool("same")];
        m.context = [{ id: "same", title: "t", modes: ["chat"], sources: ["user"] }];
      },
      [],
    ],
  ])("%s", (_name, change, expected) => {
    expect(errorsOf(mutated(change))).toEqual(expected);
  });
});

describe("validateManifest: 字段结构", () => {
  it.each<[string, (m: Record<string, any>) => void, Array<{ code: string; path: string }>]>([
    ["缺少 id", (m) => delete m.id, [{ code: "required", path: "/id" }]],
    ["缺少 main", (m) => delete m.main, [{ code: "required", path: "/main" }]],
    ["name 为空串", (m) => (m.name = " "), [{ code: "invalid_value", path: "/name" }]],
    ["name 不是字符串", (m) => (m.name = 5), [{ code: "invalid_type", path: "/name" }]],
    ["未知顶层字段", (m) => (m.homepage = "x"), [{ code: "unknown_field", path: "/homepage" }]],
    ["工具里的未知字段", (m) => (m.tools[0].safe = true), [{ code: "unknown_field", path: "/tools/0/safe" }]],
    ["native 不是布尔值", (m) => (m.native = "no"), [{ code: "invalid_type", path: "/native" }]],
    ["platforms 含未知平台", (m) => (m.platforms = ["win32", "beos"]), [{ code: "platform_invalid", path: "/platforms/1" }]],
    ["窗口宽度为 0", (m) => (m.ui.windows[0].width = 0), [{ code: "invalid_value", path: "/ui/windows/0/width" }]],
    ["窗口高度不是整数", (m) => (m.ui.windows[0].height = 1.5), [{ code: "invalid_value", path: "/ui/windows/0/height" }]],
    ["tools 元素不是对象", (m) => (m.tools = ["x"]), [{ code: "invalid_type", path: "/tools/0" }]],
    ["author 缺 name", (m) => (m.author = {}), [{ code: "required", path: "/author/name" }]],
    [
      "多处错误一次全部返回，不在第一处停下",
      (m) => {
        m.id = "x";
        m.version = "1";
        m.tools[0].risk = ["safe"];
      },
      [
        { code: "invalid_id", path: "/id" },
        { code: "invalid_version", path: "/version" },
        { code: "risk_safe_forbidden", path: "/tools/0/risk/0" },
      ],
    ],
  ])("%s", (_name, change, expected) => {
    expect(errorsOf(mutated(change))).toEqual(expected);
  });
});

describe("清单 JSON Schema 与类型、校验器不漂移", () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validateSchema = ajv.compile(schema);
  const props = (node: any): string[] => Object.keys(node.properties).sort();
  const keys = (obj: object): string[] => Object.keys(obj).sort();

  it("各对象的字段全集与类型里的 MANIFEST_KEYS 一致", () => {
    const s: any = schema;
    expect(props(s)).toEqual(keys(MANIFEST_KEYS.root));
    expect(props(s.properties.author)).toEqual(keys(MANIFEST_KEYS.author));
    expect(props(s.properties.tools.items)).toEqual(keys(MANIFEST_KEYS.tool));
    expect(props(s.properties.context.items)).toEqual(keys(MANIFEST_KEYS.context));
    expect(props(s.properties.channels.items)).toEqual(keys(MANIFEST_KEYS.channel));
    expect(props(s.properties.ui)).toEqual(keys(MANIFEST_KEYS.ui));
    expect(props(s.properties.ui.properties.settings)).toEqual(keys(MANIFEST_KEYS.settings));
    expect(props(s.properties.ui.properties.windows.items)).toEqual(keys(MANIFEST_KEYS.window));
  });

  it("必填字段与类型一致（类型里没有问号的字段）", () => {
    const s: any = schema;
    expect([...s.required].sort()).toEqual(["id", "main", "name", "schemaVersion", "sdk", "version"]);
    expect([...s.properties.tools.items.required].sort()).toEqual(["modes", "name", "risk", "title"]);
    expect([...s.properties.context.items.required].sort()).toEqual(["id", "modes", "sources", "title"]);
    expect([...s.properties.channels.items.required].sort()).toEqual(["id", "title"]);
    expect([...s.properties.ui.properties.settings.required].sort()).toEqual(["entry", "title"]);
    expect([...s.properties.ui.properties.windows.items.required].sort()).toEqual(["entry", "id", "title"]);
  });

  it("枚举取值与类型文件导出的常量一致，且风险枚举不含 safe", () => {
    const s: any = schema;
    expect(s.properties.tools.items.properties.risk.items.enum).toEqual([...PLUGIN_TOOL_RISKS]);
    expect(s.properties.tools.items.properties.risk.items.enum).not.toContain("safe");
    expect(s.properties.tools.items.properties.modes.items.enum).toEqual([...PLUGIN_TOOL_MODES]);
    expect(s.properties.context.items.properties.modes.items.enum).toEqual([...PLUGIN_CONTEXT_MODES]);
    expect(s.properties.context.items.properties.sources.items.enum).toEqual([...PLUGIN_RUN_SOURCES]);
    expect(s.properties.permissions.items.enum).toEqual([...PLUGIN_PERMISSIONS]);
    expect(s.properties.platforms.items.enum).toEqual([...PLUGIN_PLATFORMS]);
  });

  it("规格示例两边都通过", () => {
    expect(validateSchema(baseManifest())).toBe(true);
    expect(errorsOf(baseManifest())).toEqual([]);
  });

  // 每一项都是“结构性”错误：Schema 和校验器必须同时拒绝，且校验器的错误路径落在同一字段
  it.each<[string, (m: Record<string, any>) => void, string]>([
    ["schemaVersion 为 2", (m) => (m.schemaVersion = 2), "/schemaVersion"],
    ["id 只有两段", (m) => (m.id = "firefly.weather"), "/id"],
    ["id 超过 64 字符", (m) => (m.id = `dev.firefly.${"a".repeat(60)}`), "/id"],
    ["缺少 main", (m) => delete m.main, "/main"],
    ["main 扩展名不对", (m) => (m.main = "index.js"), "/main"],
    ["tools[].risk 为 safe", (m) => (m.tools[0].risk = ["safe"]), "/tools/0/risk/0"],
    ["tools[].risk 为空", (m) => (m.tools[0].risk = []), "/tools/0/risk"],
    ["tools[].modes 含 chat", (m) => (m.tools[0].modes = ["chat"]), "/tools/0/modes/0"],
    ["permissions 含未知值", (m) => (m.permissions = ["tools"]), "/permissions/0"],
    ["未知顶层字段", (m) => (m.extra = 1), "/extra"],
    ["窗口宽度为 0", (m) => (m.ui.windows[0].width = 0), "/ui/windows/0/width"],
    ["native 不是布尔值", (m) => (m.native = 1), "/native"],
  ])("Schema 与校验器一致拒绝：%s", (_name, change, path) => {
    const m = mutated(change);
    expect(validateSchema(m)).toBe(false);
    expect(errorsOf(m).map((e) => e.path)).toContain(path);
  });
});
