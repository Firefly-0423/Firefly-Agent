import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { ManifestError } from "../../../shared/plugin-manifest";
import { inspectPackage } from "./inspect";

export type PackResult =
  | { ok: true; outFile: string; entries: string[]; bytes: number }
  | { ok: false; errors: ManifestError[] };

// ZIP 条目时间固定，同样的内容打出的包字节一致（便于比对和缓存）
const ENTRY_DATE = new Date(Date.UTC(2020, 0, 1));

/** 校验后把插件包目录打成 .ffplugin（ZIP）。校验不通过时不写任何文件。 */
export async function packPackage(dir: string, outFile: string, options: { hostVersion: string }): Promise<PackResult> {
  const inspected = await inspectPackage(dir, options);
  if (!inspected.ok) return { ok: false, errors: inspected.errors };

  const root = await realpath(path.resolve(dir));
  const target = path.resolve(outFile);
  const relativeToRoot = path.relative(root, target);
  if (relativeToRoot !== "" && !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) {
    return { ok: false, errors: [{ code: "invalid_path", path: "", message: `输出文件不能放在包目录内: ${outFile}` }] };
  }

  const zip = new JSZip();
  for (const file of inspected.files) {
    zip.file(file, await readFile(path.join(root, file)), { date: ENTRY_DATE, createFolders: false });
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return { ok: true, outFile: target, entries: inspected.files, bytes: buffer.length };
}
