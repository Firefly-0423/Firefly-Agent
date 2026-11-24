import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_FILES, createPackage, createTempWorkspace, goodManifest, type TempWorkspace } from "../package/package.test-support";
import { DEFAULT_HOST_VERSION, runCli } from "./main";

let ws: TempWorkspace;
beforeEach(() => {
  ws = createTempWorkspace();
});
afterEach(() => ws.cleanup());

async function run(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("firefly-plugin validate", () => {
  it("合法的包：退出码 0，输出 id、版本和文件数，不输出错误", async () => {
    const root = createPackage(ws.base);
    const result = await run("validate", root);
    expect(result).toEqual({ code: 0, out: ["通过: dev.firefly.sample@1.0.0（4 个文件）"], err: [] });
  });

  it("不合法的包：退出码 1，每个错误一行（code、字段路径、说明），末尾给出总数", async () => {
    const root = createPackage(ws.base, {
      manifest: goodManifest({ tools: [{ name: "t", title: "t", risk: ["safe"], modes: ["work"] }] }),
    });
    const { code, out, err } = await run("validate", root);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(2);
    expect(err[0]).toMatch(/^错误 risk_safe_forbidden \/tools\/0\/risk\/0: .*safe/);
    expect(err[1]).toBe("共 1 个错误");
  });

  it("包边界错误同样退出 1，并带出文件名", async () => {
    const root = createPackage(ws.base, { manifest: goodManifest({ native: false }), files: { ...GOOD_FILES, "addon.node": "x" } });
    const { code, err } = await run("validate", root);
    expect(code).toBe(1);
    expect(err[0]).toBe("错误 native_binary_undeclared /native: 包内含原生文件 addon.node，但清单没有声明 native: true [addon.node]");
  });

  it("0.x 清单：退出 1，提示 1.2.0 不再支持", async () => {
    const root = createPackage(ws.base, { manifest: { id: "old", name: "n", version: "0.1.0", apiVersion: 1, entry: "index.js" }, files: {} });
    const { code, err } = await run("validate", root);
    expect(code).toBe(1);
    expect(err[0]).toContain("legacy_manifest");
    expect(err[0]).toContain("1.2.0 不再支持");
  });

  it("目录不存在：退出 1 而不是抛异常", async () => {
    const { code, err } = await run("validate", path.join(ws.base, "missing"));
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^错误 manifest_missing /);
  });

  it("默认对照宿主 1.2.0；--host-version 可改，sdk 范围不满足时退出 1", async () => {
    expect(DEFAULT_HOST_VERSION).toBe("1.2.0");
    const root = createPackage(ws.base);
    expect((await run("validate", root, "--host-version", "1.2.5")).code).toBe(0);
    const old = await run("validate", root, "--host-version", "1.1.0");
    expect(old.code).toBe(1);
    expect(old.err[0]).toMatch(/^错误 sdk_unsatisfied \/sdk: /);
  });
});

describe("firefly-plugin pack", () => {
  it("合法的包：退出码 0，生成 ZIP，条目与包内文件一致", async () => {
    const root = createPackage(ws.base);
    const out = path.join(ws.base, "dist-out", "sample.ffplugin");
    const result = await run("pack", root, "-o", out);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([expect.stringContaining("已生成")]);

    const zip = await JSZip.loadAsync(readFileSync(out));
    expect(Object.keys(zip.files).sort()).toEqual(["assets/icon.png", "dist/index.mjs", "firefly.plugin.json", "ui/settings.html"]);
  });

  it("不合法的包：退出 1，打印错误和“未生成任何文件”，输出文件不存在", async () => {
    const root = createPackage(ws.base, { manifest: goodManifest({ id: "bad" }) });
    const out = path.join(ws.base, "bad.ffplugin");
    const { code, out: stdout, err } = await run("pack", root, "-o", out);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(err[0]).toMatch(/^错误 invalid_id \/id: /);
    expect(err.at(-1)).toBe("未生成任何文件");
    expect(existsSync(out)).toBe(false);
  });
});

describe("firefly-plugin 用法错误", () => {
  it.each<[string, string[], string]>([
    ["没有命令", [], "用法:"],
    ["未知命令", ["publish", "x"], "未知命令 publish"],
    ["validate 缺目录", ["validate"], "需要且只需要一个包目录"],
    ["validate 多个目录", ["validate", "a", "b"], "需要且只需要一个包目录"],
    ["pack 缺 -o", ["pack", "dir"], "pack 需要 -o"],
    ["-o 缺值", ["pack", "dir", "-o"], "-o 需要一个值"],
    ["validate 带 -o", ["validate", "dir", "-o", "x"], "validate 不接受 -o"],
    ["未知选项", ["validate", "dir", "--fix"], "未知选项 --fix"],
  ])("%s：退出 2 并打印用法，不碰文件系统", async (_name, argv, message) => {
    const { code, out, err } = await run(...argv);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain(message);
  });

  it("--help 退出 0 并打印用法到标准输出", async () => {
    const { code, out, err } = await run("--help");
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("firefly-plugin validate");
    expect(err).toEqual([]);
  });
});
