import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packPackage } from "./pack";
import { GOOD_FILES, HOST_VERSION, createPackage, createTempWorkspace, goodManifest, type TempWorkspace } from "./package.test-support";

let ws: TempWorkspace;
beforeEach(() => {
  ws = createTempWorkspace();
});
afterEach(() => ws.cleanup());

const pack = (dir: string, out: string) => packPackage(dir, out, { hostVersion: HOST_VERSION });

describe("packPackage", () => {
  it("生成的 ZIP 条目与包内文件一一对应，内容一致，没有多余条目", async () => {
    const root = createPackage(ws.base, { files: { ...GOOD_FILES, "ui/deep/page.html": "<p>x</p>" } });
    const out = path.join(ws.base, "out", "sample.ffplugin");

    const result = await pack(root, out);
    expect(result).toMatchObject({ ok: true, outFile: out });

    const zip = await JSZip.loadAsync(readFileSync(out));
    const fileEntries = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
    expect(fileEntries).toEqual(["assets/icon.png", "dist/index.mjs", "firefly.plugin.json", "ui/deep/page.html", "ui/settings.html"]);
    expect(Object.values(zip.files).filter((entry) => entry.dir)).toEqual([]);
    expect(await zip.file("dist/index.mjs")!.async("string")).toBe(GOOD_FILES["dist/index.mjs"]);
    expect(JSON.parse(await zip.file("firefly.plugin.json")!.async("string"))).toEqual(goodManifest());
  });

  it("同一个包打两次，ZIP 字节完全一致", async () => {
    const root = createPackage(ws.base);
    await pack(root, path.join(ws.base, "a.ffplugin"));
    await pack(root, path.join(ws.base, "b.ffplugin"));
    expect(readFileSync(path.join(ws.base, "a.ffplugin")).equals(readFileSync(path.join(ws.base, "b.ffplugin")))).toBe(true);
  });

  it("包不合法时拒绝打包，返回校验错误，且不创建输出文件", async () => {
    const root = createPackage(ws.base, { manifest: goodManifest({ tools: [{ name: "t", title: "t", risk: ["safe"], modes: ["work"] }] }) });
    const out = path.join(ws.base, "out", "bad.ffplugin");

    const result = await pack(root, out);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((e) => ({ code: e.code, path: e.path }))).toEqual([{ code: "risk_safe_forbidden", path: "/tools/0/risk/0" }]);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.dirname(out))).toBe(false);
  });

  it("包边界不合法（缺 main）时拒绝打包", async () => {
    const root = createPackage(ws.base, { files: { "assets/icon.png": "png", "ui/settings.html": "x" } });
    const out = path.join(ws.base, "bad.ffplugin");
    const result = await pack(root, out);
    expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual(["file_missing"]);
    expect(existsSync(out)).toBe(false);
  });

  it("输出文件放在包目录里时拒绝，避免下次打包把旧包也装进去", async () => {
    const root = createPackage(ws.base);
    const out = path.join(root, "self.ffplugin");
    const result = await pack(root, out);
    expect(result.ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});
