import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPackageBoundary } from "./boundary";
import { inspectPackage } from "./inspect";
import {
  CAN_LINK_DIRECTORY,
  CAN_SYMLINK_FILE,
  GOOD_FILES,
  HOST_VERSION,
  createPackage,
  createTempWorkspace,
  goodManifest,
  linkDirectory,
  linkFile,
  writeFiles,
  type TempWorkspace,
} from "./package.test-support";

let ws: TempWorkspace;
beforeEach(() => {
  ws = createTempWorkspace();
});
afterEach(() => ws.cleanup());

const inspect = (dir: string) => inspectPackage(dir, { hostVersion: HOST_VERSION });
const codes = (errors: Array<{ code: string; path: string }>) => errors.map(({ code, path: p }) => ({ code, path: p }));

describe("inspectPackage: 合法的包", () => {
  it("返回清单和包内全部文件（相对路径、正斜杠、有序），清单文件也在内", async () => {
    const root = createPackage(ws.base);
    const result = await inspect(root);
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["assets/icon.png", "dist/index.mjs", "firefly.plugin.json", "ui/settings.html"]);
    expect(result.errors).toEqual([]);
  });

  it("清单带 UTF-8 BOM 也能读", async () => {
    const root = createPackage(ws.base);
    writeFileSync(path.join(root, "firefly.plugin.json"), `\uFEFF${JSON.stringify(goodManifest())}`);
    expect((await inspect(root)).ok).toBe(true);
  });

  it(".cjs 入口通过", async () => {
    const root = createPackage(ws.base, { manifest: goodManifest({ main: "index.cjs" }), files: { ...GOOD_FILES, "index.cjs": "module.exports={}" } });
    expect((await inspect(root)).ok).toBe(true);
  });
});

describe("inspectPackage: 清单读取", () => {
  it("目录不存在", async () => {
    const result = await inspect(path.join(ws.base, "nope"));
    expect(codes(result.errors)).toEqual([{ code: "manifest_missing", path: "" }]);
  });

  it("目录里没有 firefly.plugin.json", async () => {
    const root = path.join(ws.base, "empty");
    mkdirSync(root);
    expect(codes((await inspect(root)).errors)).toEqual([{ code: "manifest_missing", path: "" }]);
  });

  it("清单不是合法 JSON", async () => {
    const root = createPackage(ws.base);
    writeFileSync(path.join(root, "firefly.plugin.json"), "{ not json");
    expect(codes((await inspect(root)).errors)).toEqual([{ code: "manifest_json", path: "" }]);
  });

  it("0.x 清单被拒绝，并且不去检查文件", async () => {
    const root = createPackage(ws.base, {
      manifest: { id: "old", name: "n", version: "0.1.0", apiVersion: 1, description: "d", author: "a", entry: "index.js" },
      files: {},
    });
    const result = await inspect(root);
    expect(codes(result.errors)).toEqual([{ code: "legacy_manifest", path: "" }]);
    expect(result.errors[0].message).toContain("0.x");
  });
});

describe("包边界：路径写法逃出包根", () => {
  // 包外放一个真实存在的文件，证明被拒绝的原因是路径本身，而不是文件不存在
  it.each<[string, (outside: string) => string, string]>([
    ["含 .. 的相对路径", () => "../outside.mjs", "path_traversal"],
    ["中途 .. 回到包根外", () => "dist/../../outside.mjs", "path_traversal"],
    ["绝对路径", (outside) => outside, "path_absolute"],
    ["盘符路径", () => "C:\\Windows\\outside.mjs", "path_absolute"],
    ["UNC 路径", () => "\\\\server\\share\\outside.mjs", "path_absolute"],
  ])("main 使用%s被拒绝", async (_name, makeMain, code) => {
    const outside = path.join(ws.base, "outside.mjs");
    writeFileSync(outside, "export default {};");
    const root = createPackage(ws.base, { manifest: goodManifest({ main: makeMain(outside) }) });
    const result = await inspect(root);
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual([{ code, path: "/main" }]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["icon", { icon: "../outside.png" }, "/icon"],
    ["settings 入口", { ui: { settings: { entry: "../outside.html", title: "t" } } }, "/ui/settings/entry"],
    ["窗口入口", { ui: { windows: [{ id: "w", entry: "../outside.html", title: "t" }] } }, "/ui/windows/0/entry"],
  ])("%s含 .. 被拒绝", async (_name, override, pointer) => {
    const root = createPackage(ws.base, { manifest: goodManifest(override) });
    expect(codes((await inspect(root)).errors)).toEqual([{ code: "path_traversal", path: pointer }]);
  });

  it("checkPackageBoundary 不依赖前置的清单校验：直接传入越界清单也会拒绝", async () => {
    const root = createPackage(ws.base);
    const manifest = goodManifest({ main: "../outside.mjs", icon: "/abs.png" }) as never;
    const { errors } = await checkPackageBoundary(root, manifest);
    expect(codes(errors)).toEqual([
      { code: "path_traversal", path: "/main" },
      { code: "path_absolute", path: "/icon" },
    ]);
  });
});

describe("包边界：符号链接与 junction", () => {
  it.skipIf(!CAN_LINK_DIRECTORY)("main 经目录 junction 指向包外时被拒绝，且仍在包内的文件不受影响（跳过原因：无法创建 junction）", async () => {
    const outsideDir = path.join(ws.base, "outside-dir");
    writeFiles(outsideDir, { "index.mjs": "export default { stolen: true };" });
    const root = createPackage(ws.base, { files: { "assets/icon.png": "png", "ui/settings.html": "<!doctype html>" } });
    linkDirectory(outsideDir, path.join(root, "dist"));

    const result = await inspect(root);
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContainEqual({ code: "path_symlink_escape", path: "/main" });
    expect(codes(result.errors)).not.toContainEqual({ code: "file_missing", path: "/main" });
  });

  it.skipIf(!CAN_SYMLINK_FILE)("icon 是指向包外文件的符号链接时被拒绝（跳过原因：当前账户无权创建文件符号链接）", async () => {
    const outsideFile = path.join(ws.base, "secret.png");
    writeFileSync(outsideFile, "secret");
    const root = createPackage(ws.base, { files: { "dist/index.mjs": "export default {};", "ui/settings.html": "<!doctype html>" } });
    linkFile(outsideFile, path.join(root, "assets-icon.png"));
    writeFileSync(path.join(root, "firefly.plugin.json"), JSON.stringify(goodManifest({ icon: "assets-icon.png" })));

    expect(codes((await inspect(root)).errors)).toContainEqual({ code: "path_symlink_escape", path: "/icon" });
  });

  it.skipIf(!CAN_LINK_DIRECTORY)("没有被清单引用的链接也不接受：包内出现 junction 即拒绝并指出文件（跳过原因：无法创建 junction）", async () => {
    const outsideDir = path.join(ws.base, "outside-dir");
    mkdirSync(outsideDir);
    const root = createPackage(ws.base);
    linkDirectory(outsideDir, path.join(root, "extra"));

    const result = await inspect(root);
    expect(result.errors).toEqual([expect.objectContaining({ code: "symlink_not_allowed", path: "", file: "extra" })]);
  });
});

describe("包边界：main 的存在与扩展名", () => {
  it("main 指向的文件不存在", async () => {
    const root = createPackage(ws.base, { files: { "assets/icon.png": "png", "ui/settings.html": "<!doctype html>" } });
    expect(codes((await inspect(root)).errors)).toEqual([{ code: "file_missing", path: "/main" }]);
  });

  it("main 指向目录而不是文件", async () => {
    const root = createPackage(ws.base, { files: { "assets/icon.png": "png", "ui/settings.html": "<!doctype html>", "dist/index.mjs/inner.txt": "x" } });
    expect(codes((await inspect(root)).errors)).toEqual([{ code: "file_missing", path: "/main" }]);
  });

  it("main 扩展名是 .js（文件存在）被拒绝", async () => {
    const root = createPackage(ws.base, { manifest: goodManifest({ main: "dist/index.js" }), files: { ...GOOD_FILES, "dist/index.js": "x" } });
    expect(codes((await inspect(root)).errors)).toEqual([{ code: "main_extension", path: "/main" }]);
  });

  it("icon 和 ui 入口文件不存在也被指出", async () => {
    const root = createPackage(ws.base, { files: { "dist/index.mjs": "export default {};" } });
    expect(codes((await inspect(root)).errors)).toEqual([
      { code: "file_missing", path: "/icon" },
      { code: "file_missing", path: "/ui/settings/entry" },
    ]);
  });
});

describe("包边界：native 与原生文件", () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ["native: false 且含 .node", { native: false }, ["build/addon.node"]],
    ["未写 native 且含 .node", { native: undefined }, ["build/addon.node"]],
    ["native: false 且含大写 .DLL", { native: false }, ["bin/Helper.DLL"]],
  ])("%s被拒绝，错误指向 /native 并列出文件", async (_name, override, nativeFiles) => {
    const root = createPackage(ws.base, {
      manifest: goodManifest(override),
      files: { ...GOOD_FILES, ...Object.fromEntries(nativeFiles.map((f) => [f, "bin"])) },
    });
    const result = await inspect(root);
    expect(result.errors).toEqual(nativeFiles.map((file) => expect.objectContaining({ code: "native_binary_undeclared", path: "/native", file })));
  });

  it("每个原生文件各报一条，子目录里的也找得到", async () => {
    const root = createPackage(ws.base, { files: { ...GOOD_FILES, "a.node": "x", "deep/er/b.dll": "x" } });
    expect((await inspect(root)).errors.map((e) => e.file)).toEqual(["a.node", "deep/er/b.dll"]);
  });

  it("native: true 时同样的文件通过", async () => {
    const root = createPackage(ws.base, { manifest: goodManifest({ native: true }), files: { ...GOOD_FILES, "build/addon.node": "x", "bin/h.dll": "x" } });
    expect((await inspect(root)).ok).toBe(true);
  });

  it("名字里只是含 node 或 dll 字样的文件不算原生文件", async () => {
    const root = createPackage(ws.base, { files: { ...GOOD_FILES, "docs/node.md": "x", "notes/dll-info.txt": "x", "a.nodejs": "x" } });
    expect((await inspect(root)).ok).toBe(true);
  });
});
