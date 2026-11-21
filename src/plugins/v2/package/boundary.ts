/**
 * 1.2.0 插件包的文件系统边界检查（规格 §4 规则 3、§9）。只依赖 Node，不引用 Electron。
 *
 * - main、icon、ui.*.entry 必须解析到包根目录以内（拒绝 ..、绝对路径、盘符、UNC，
 *   以及经符号链接或 junction 指向包外的路径）。
 * - main 必须存在且以 .mjs 或 .cjs 结尾。
 * - native 不是 true 时，包内不得出现 .node / .dll 文件。
 * - 包内任何符号链接 / junction 一律不接受：打包时不能确定它会带走什么。
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { checkRelativePathShape } from "../../../shared/plugin-manifest";
import type { ManifestError, PluginManifestV1 } from "../../../shared/plugin-manifest";

const NATIVE_BINARY = /\.(node|dll)$/i;
const MAIN_EXTENSIONS = [".mjs", ".cjs"];

export interface PackageScan {
  /** 相对包根的文件路径，正斜杠，按字典序。 */
  files: string[];
  errors: ManifestError[];
}

interface PathRef {
  /** 该路径在清单里的 JSON Pointer。 */
  pointer: string;
  value: string;
}

function collectPathRefs(manifest: PluginManifestV1): PathRef[] {
  const refs: PathRef[] = [{ pointer: "/main", value: manifest.main }];
  if (manifest.icon !== undefined) refs.push({ pointer: "/icon", value: manifest.icon });
  if (manifest.ui?.settings) refs.push({ pointer: "/ui/settings/entry", value: manifest.ui.settings.entry });
  manifest.ui?.windows?.forEach((window, index) => refs.push({ pointer: `/ui/windows/${index}/entry`, value: window.entry }));
  return refs;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

/** 递归列出包内文件；遇到符号链接或 junction 记错且不跟随。 */
export async function scanPackage(root: string, manifest: Pick<PluginManifestV1, "native">): Promise<PackageScan> {
  const files: string[] = [];
  const errors: ManifestError[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, full));
      // Dirent 对 Windows junction 报告为目录；以 lstat 的结果为准
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        errors.push({ code: "symlink_not_allowed", path: "", file: relative, message: `包内不允许符号链接或 junction: ${relative}` });
      } else if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile()) {
        files.push(relative);
        if (manifest.native !== true && NATIVE_BINARY.test(entry.name)) {
          errors.push({
            code: "native_binary_undeclared",
            path: "/native",
            file: relative,
            message: `包内含原生文件 ${relative}，但清单没有声明 native: true`,
          });
        }
      }
    }
  }

  await walk(root);
  return { files, errors };
}

/** 检查清单引用的路径落在包内且文件存在，并扫描包内文件。 */
export async function checkPackageBoundary(
  root: string,
  manifest: PluginManifestV1,
): Promise<{ files: string[]; errors: ManifestError[] }> {
  const errors: ManifestError[] = [];
  const realRoot = await realpath(root);

  for (const { pointer, value } of collectPathRefs(manifest)) {
    const shape = checkRelativePathShape(value);
    if (shape) {
      errors.push({ code: shape, path: pointer, message: `${pointer} 不是合法的包内相对路径: ${JSON.stringify(value)}` });
      continue;
    }
    if (pointer === "/main" && !MAIN_EXTENSIONS.some((ext) => value.endsWith(ext))) {
      errors.push({ code: "main_extension", path: pointer, message: "main 必须是 .mjs 或 .cjs 文件" });
      continue;
    }

    const lexical = path.resolve(realRoot, value);
    if (!isInside(realRoot, lexical)) {
      errors.push({ code: "path_traversal", path: pointer, message: `${pointer} 解析到包根目录之外` });
      continue;
    }

    let resolved: string;
    try {
      resolved = await realpath(lexical);
    } catch {
      errors.push({ code: "file_missing", path: pointer, message: `${pointer} 指向的文件不存在: ${value}`, file: toPosix(value) });
      continue;
    }
    if (!isInside(realRoot, resolved)) {
      errors.push({ code: "path_symlink_escape", path: pointer, message: `${pointer} 经符号链接指向包外: ${value}`, file: toPosix(value) });
      continue;
    }
    if (!(await stat(resolved)).isFile()) {
      errors.push({ code: "file_missing", path: pointer, message: `${pointer} 指向的不是文件: ${value}`, file: toPosix(value) });
    }
  }

  const scan = await scanPackage(realRoot, manifest);
  return { files: scan.files, errors: [...errors, ...scan.errors] };
}
