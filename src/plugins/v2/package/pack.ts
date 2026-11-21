import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { ManifestError } from "../../../shared/plugin-manifest";
import { escapesRoot } from "./boundary";
import { inspectPackage } from "./inspect";

export type PackResult =
  | { ok: true; outFile: string; entries: string[]; bytes: number }
  | { ok: false; errors: ManifestError[] };

// ZIP 条目时间固定，同样的内容打出的包字节一致（便于比对和缓存）
const ENTRY_DATE = new Date(Date.UTC(2020, 0, 1));

/** The real path of a file that may not exist yet: resolve its nearest existing ancestor, keep the rest. */
async function realTarget(file: string): Promise<string> {
  const missing: string[] = [];
  let current = file;
  for (;;) {
    let exists = true;
    try {
      await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    // An entry that exists but cannot be resolved is a dangling link: writing through it would follow the link
    // to wherever it points, so refuse instead of treating it as a missing path.
    if (exists) return path.join(await realpath(current), ...missing);
    const parent = path.dirname(current);
    if (parent === current) return file;
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/** 校验后把插件包目录打成 .ffplugin（ZIP）。校验不通过时不写任何文件。 */
export async function packPackage(dir: string, outFile: string, options: { hostVersion: string }): Promise<PackResult> {
  const inspected = await inspectPackage(dir, options);
  if (!inspected.ok) return { ok: false, errors: inspected.errors };

  const root = await realpath(path.resolve(dir));
  const target = path.resolve(outFile);
  // Compare real paths: an output reached through a link or junction must not land inside the package.
  let realOut: string;
  try {
    realOut = await realTarget(target);
  } catch {
    return { ok: false, errors: [{ code: "invalid_path", path: "", message: `输出路径无法解析（可能是悬空链接）: ${outFile}` }] };
  }
  const relativeToRoot = path.relative(root, realOut);
  if (!escapesRoot(relativeToRoot)) {
    return { ok: false, errors: [{ code: "invalid_path", path: "", message: `输出文件不能放在包目录内: ${outFile}` }] };
  }

  const zip = new JSZip();
  for (const file of inspected.files) {
    zip.file(file, await readFile(path.join(root, file)), { date: ENTRY_DATE, createFolders: false });
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });

  await mkdir(path.dirname(target), { recursive: true });
  // Write a fresh file and rename it over the output: writing in place would follow a hard link that the
  // output may share with a package file (realpath cannot see hard links) and truncate that file.
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(staging, buffer, { flag: "wx" });
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true });
  }
  return { ok: true, outFile: target, entries: inspected.files, bytes: buffer.length };
}
