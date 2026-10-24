// 检查 mpv.exe：文件大小、MZ 文件头，以及可选的 --version 试运行。
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";

const run = promisify(execFile);
// mpv.exe 实际有几十 MB，1 MB 只是最低门槛
const SIZE_FLOOR = 1024 * 1024;

/** 读取文件最前面两个字节，判断是不是 Windows 可执行文件（"MZ"）。 */
async function startsWithMz(filePath) {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.toString("ascii") === "MZ";
  } finally {
    await handle.close();
  }
}

/** 运行 `mpv --version`，返回去掉首尾空白的首行；输出不像 mpv 时抛错。 */
async function probeVersion(helperPath) {
  try {
    const { stdout } = await run(helperPath, ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    const head = stdout.split(/\r?\n/)[0] ?? "";
    if (!/mpv/i.test(head)) {
      throw new Error(`mpv --version 输出异常：${head}`);
    }
    return head.trim();
  } catch (err) {
    throw new Error(`mpv --version 探测失败：${err.message}`);
  }
}

export async function verifyMpvHelper(inputPath, { runVersion = true } = {}) {
  const helperPath = path.resolve(inputPath);
  const info = await stat(helperPath);
  if (!info.isFile()) {
    throw new Error(`mpv is not a file: ${helperPath}`);
  }
  if (info.size <= SIZE_FLOOR) {
    throw new Error(`mpv is too small (${info.size} bytes): ${helperPath}`);
  }
  if (!(await startsWithMz(helperPath))) {
    throw new Error(`mpv is not a Windows executable: ${helperPath}`);
  }

  if (!runVersion) {
    return { helperPath, size: info.size };
  }
  const version = await probeVersion(helperPath);
  return { helperPath, size: info.size, version };
}

async function main() {
  const [, , target] = process.argv;
  if (!target) {
    throw new Error("Usage: node scripts/verify/mpv-helper.mjs <path-to-mpv.exe>");
  }
  const { helperPath, size, version } = await verifyMpvHelper(target);
  console.log(`[mpv] verified ${helperPath} (${size} bytes) — ${version ?? "no version"}`);
}

// 仅在被直接执行时运行 main，被 import 时不触发
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[mpv] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
