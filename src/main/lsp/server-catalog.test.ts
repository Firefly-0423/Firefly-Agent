import { describe, expect, it } from "vitest";
import type { LspServerOverride } from "./types";
import { BUILTIN_LSP_SERVERS, findServerCandidates, normalizeLspServerOverrides } from "./server-catalog";

const idsFor = (file: string, overrides: LspServerOverride[] = []) =>
  findServerCandidates(file, overrides).map((d) => d.id);

describe("内置服务表结构", () => {
  it("id 唯一，扩展名带点且为小写", () => {
    const ids = BUILTIN_LSP_SERVERS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of BUILTIN_LSP_SERVERS) {
      expect(d.extensions.length).toBeGreaterThan(0);
      for (const ext of d.extensions) expect(ext).toMatch(/^\.[a-z0-9]+$/);
    }
  });

  it("每项都有命令、根标记与安装提示", () => {
    for (const d of BUILTIN_LSP_SERVERS) {
      expect(d.commands.length).toBeGreaterThan(0);
      for (const c of d.commands) {
        expect(c.command.trim()).not.toBe("");
        expect(Array.isArray(c.args)).toBe(true);
      }
      expect(d.rootMarkers.length).toBeGreaterThan(0);
      expect(d.installHint.length).toBeGreaterThan(5);
    }
  });
});

describe("findServerCandidates 按扩展名匹配", () => {
  it.each([
    ["a/b/main.go", "gopls"],
    ["lib.rs", "rust-analyzer"],
    ["tool.py", "python-pyright"],
    ["stub.pyi", "python-pyright"],
    ["Foo.java", "jdtls"],
    ["App.vue", "vue-language-server"],
    ["ci.yml", "yaml-language-server"],
    ["init.lua", "lua-language-server"],
    ["x.cpp", "clangd"],
    ["Program.cs", "omnisharp"],
    ["script.csx", "omnisharp"],
    ["index.php", "intelephense"],
    ["app.rb", "ruby-lsp"],
    ["tasks.rake", "ruby-lsp"],
    ["Main.kt", "kotlin-language-server"],
    ["build.gradle.kts", "kotlin-language-server"],
  ])("%s 对应 %s", (file, id) => {
    expect(idsFor(file)).toEqual([id]);
  });

  it("每个内置服务器的扩展名集合固定：丢掉或改派任何一个扩展名都会失败", () => {
    const expected: Record<string, string[]> = {
      "typescript-language-server": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
      "python-pyright": [".py", ".pyi"],
      gopls: [".go"],
      "rust-analyzer": [".rs"],
      clangd: [".c", ".h", ".cc", ".cp", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
      jdtls: [".java"],
      omnisharp: [".cs", ".csx"],
      intelephense: [".php"],
      "ruby-lsp": [".rb", ".rake", ".gemspec"],
      "kotlin-language-server": [".kt", ".kts"],
      "lua-language-server": [".lua"],
      "vue-language-server": [".vue"],
      "yaml-language-server": [".yaml", ".yml"],
    };
    expect(BUILTIN_LSP_SERVERS.map((d) => d.id)).toEqual(Object.keys(expected));
    for (const def of BUILTIN_LSP_SERVERS) expect([...def.extensions]).toEqual(expected[def.id]);
  });

  it("TypeScript 的主扩展名 .ts 仍归 typescript-language-server", () => {
    expect(idsFor("src/app.ts")).toEqual(["typescript-language-server"]);
    expect(idsFor("src/app.mts")).toEqual([]);
  });

  it("目录里声明的每个扩展名都能查到它自己的服务器（新增语言不会漏测）", () => {
    for (const def of BUILTIN_LSP_SERVERS) {
      for (const ext of def.extensions) {
        expect(idsFor(`sample${ext}`), `${def.id} ${ext}`).toContain(def.id);
      }
    }
  });

  it("扩展名大小写不敏感", () => {
    expect(idsFor("MAIN.GO")).toEqual(["gopls"]);
    expect(idsFor("Page.TSX")).toEqual(["typescript-language-server"]);
  });

  it("未知扩展名或没有扩展名时返回空数组", () => {
    expect(idsFor("notes.xyz")).toEqual([]);
    expect(idsFor("Makefile")).toEqual([]);
    expect(idsFor("")).toEqual([]);
  });

  it("只看最后一个扩展名", () => {
    expect(idsFor("bundle.min.js")).toEqual(["typescript-language-server"]);
    expect(idsFor("archive.go.bak")).toEqual([]);
  });

  it("无覆盖项时返回内置定义本身", () => {
    const [found] = findServerCandidates("a.go");
    expect(found).toBe(BUILTIN_LSP_SERVERS.find((d) => d.id === "gopls"));
  });
});

describe("findServerCandidates 应用覆盖项", () => {
  it("覆盖命令时替换命令列表，参数缺省为空", () => {
    const [found] = findServerCandidates("a.go", [{ id: "gopls", command: "/opt/gopls" }]);
    expect(found.commands).toEqual([{ command: "/opt/gopls", args: [] }]);
  });

  it("覆盖命令与参数", () => {
    const [found] = findServerCandidates("a.rs", [{ id: "rust-analyzer", command: "ra", args: ["-v"] }]);
    expect(found.commands).toEqual([{ command: "ra", args: ["-v"] }]);
  });

  it("只给参数而没有命令时，保留原命令不变", () => {
    const [found] = findServerCandidates("a.go", [{ id: "gopls", args: ["-x"] }]);
    expect(found.commands).toEqual([{ command: "gopls", args: [] }]);
  });

  it("覆盖不会污染内置表", () => {
    findServerCandidates("a.go", [
      { id: "gopls", command: "other", extensions: [".zzz"], initializationOptions: { a: 1 } },
    ]);
    const builtin = BUILTIN_LSP_SERVERS.find((d) => d.id === "gopls")!;
    expect(builtin.commands[0].command).toBe("gopls");
    expect(builtin.extensions).toEqual([".go"]);
    expect(builtin.initializationOptions).toBeUndefined();
  });

  it("覆盖扩展名只改返回定义，不改变文件匹配", () => {
    const found = findServerCandidates("a.go", [{ id: "gopls", extensions: [".golang"] }]);
    expect(found).toHaveLength(1);
    expect(found[0].extensions).toEqual([".golang"]);
    expect(idsFor("a.golang")).toEqual([]);
  });

  it("覆盖初始化选项", () => {
    const [found] = findServerCandidates("a.go", [{ id: "gopls", initializationOptions: { staticcheck: true } }]);
    expect(found.initializationOptions).toEqual({ staticcheck: true });
  });

  it("其他服务的覆盖项不会作用到当前服务", () => {
    const [found] = findServerCandidates("a.go", [{ id: "clangd", command: "x" }]);
    expect(found.commands[0].command).toBe("gopls");
  });

  it("字段不合法的覆盖项被整体忽略", () => {
    const [bad1] = findServerCandidates("a.go", [{ id: "gopls", command: "  " }]);
    const [bad2] = findServerCandidates("a.go", [{ id: "gopls", extensions: ["go"] }]);
    const [bad3] = findServerCandidates("a.go", [{ id: "gopls", args: [""] }]);
    for (const f of [bad1, bad2, bad3]) expect(f.commands[0].command).toBe("gopls");
  });

  it("同一 id 有多条覆盖时取第一条可用的", () => {
    const [found] = findServerCandidates("a.go", [
      { id: "gopls", command: " " },
      { id: "gopls", command: "second" },
      { id: "gopls", command: "third" },
    ]);
    expect(found.commands[0].command).toBe("second");
  });
});

describe("normalizeLspServerOverrides", () => {
  it("非数组输入得到空数组", () => {
    for (const bad of [null, undefined, {}, "x", 3]) expect(normalizeLspServerOverrides(bad)).toEqual([]);
  });

  it("保留合法条目并清理空白与大小写", () => {
    const out = normalizeLspServerOverrides([
      { id: "gopls", command: "  gp  ", args: [" -a ", "b"], extensions: [".GO "] },
    ]);
    expect(out).toEqual([{ id: "gopls", command: "gp", args: ["-a", "b"], extensions: [".go"] }]);
  });

  it("丢弃未知 id、非对象、数组和缺 id 的条目", () => {
    const out = normalizeLspServerOverrides([null, 5, "gopls", [], {}, { id: "nope" }, { id: "  " }, { id: "gopls" }]);
    expect(out).toEqual([{ id: "gopls" }]);
  });

  it("同一 id 只接受第一条合法条目", () => {
    const out = normalizeLspServerOverrides([
      { id: "gopls", command: "a" },
      { id: "gopls", command: "b" },
    ]);
    expect(out).toEqual([{ id: "gopls", command: "a" }]);
  });

  it("非法的重复条目不占用 id", () => {
    const out = normalizeLspServerOverrides([{ id: "gopls", command: "" }, { id: "gopls", command: "ok" }]);
    expect(out).toEqual([{ id: "gopls", command: "ok" }]);
  });

  it.each([
    ["命令不是字符串", { id: "gopls", command: 4 }],
    ["参数不是数组", { id: "gopls", args: "x" }],
    ["参数含空串", { id: "gopls", args: ["a", " "] }],
    ["参数含非字符串", { id: "gopls", args: [1] }],
    ["扩展名不是数组", { id: "gopls", extensions: ".go" }],
    ["扩展名缺少点号", { id: "gopls", extensions: ["go"] }],
  ])("%s 时整条丢弃", (_l, entry) => {
    expect(normalizeLspServerOverrides([entry])).toEqual([]);
  });

  it("接受由普通 JSON 值构成的初始化选项", () => {
    const opts = { a: [1, "x", null, true], b: { c: 0.5 } };
    expect(normalizeLspServerOverrides([{ id: "gopls", initializationOptions: opts }])).toEqual([
      { id: "gopls", initializationOptions: opts },
    ]);
  });

  it("初始化选项含原型键、非有限数或函数时，只去掉该字段，条目保留", () => {
    const polluted = JSON.parse('{"ok":1,"nested":{"__proto__":{"x":1}}}');
    const cases: unknown[] = [polluted, { constructor: 1 }, { prototype: 1 }, { n: Infinity }, { f: () => 1 }, [undefined]];
    for (const options of cases) {
      expect(normalizeLspServerOverrides([{ id: "gopls", command: "g", initializationOptions: options }])).toEqual([
        { id: "gopls", command: "g" },
      ]);
    }
  });
});
