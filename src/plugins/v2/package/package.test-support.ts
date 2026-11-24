import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const HOST_VERSION = "1.2.0";

export function goodManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "dev.firefly.sample",
    name: "示例",
    version: "1.0.0",
    sdk: "^1.2.0",
    main: "dist/index.mjs",
    icon: "assets/icon.png",
    native: false,
    tools: [{ name: "ping", title: "Ping", risk: ["network"], modes: ["work"] }],
    ui: { settings: { entry: "ui/settings.html", title: "设置" } },
    ...overrides,
  };
}

/** 包内默认文件：与 goodManifest 的 main、icon、ui 入口对应。 */
export const GOOD_FILES: Record<string, string> = {
  "dist/index.mjs": "export default {};\n",
  "assets/icon.png": "png",
  "ui/settings.html": "<!doctype html>",
};

export interface TempWorkspace {
  /** 测试专用的临时根目录，包目录和“包外”文件都建在里面。 */
  base: string;
  cleanup(): void;
}

export function createTempWorkspace(): TempWorkspace {
  const base = mkdtempSync(path.join(tmpdir(), "firefly-plugin-pkg-"));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** 在 base/<name> 建一个包：写清单和文件，返回包根目录。 */
export function createPackage(
  base: string,
  options: { name?: string; manifest?: unknown; files?: Record<string, string> } = {},
): string {
  const root = path.join(base, options.name ?? "pkg");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "firefly.plugin.json"), JSON.stringify(options.manifest ?? goodManifest(), null, 2));
  writeFiles(root, options.files ?? GOOD_FILES);
  return root;
}

function probe(kind: "file" | "junction"): boolean {
  const base = mkdtempSync(path.join(tmpdir(), "firefly-plugin-probe-"));
  try {
    writeFileSync(path.join(base, "target.txt"), "x");
    mkdirSync(path.join(base, "dir"));
    if (kind === "file") symlinkSync(path.join(base, "target.txt"), path.join(base, "link"), "file");
    else symlinkSync(path.join(base, "dir"), path.join(base, "link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** 当前系统/权限下能否创建文件符号链接（Windows 普通用户通常不能）与目录 junction/符号链接。 */
export const CAN_SYMLINK_FILE = probe("file");
export const CAN_LINK_DIRECTORY = probe("junction");

export function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, "junction");
}

export function linkFile(target: string, link: string): void {
  symlinkSync(target, link, "file");
}
