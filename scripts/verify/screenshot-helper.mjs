// 校验原生截图程序（firefly-screenshot.exe）是否可用于打包。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open, stat } from "node:fs/promises";

// 小于等于这个字节数的文件不可能是完整的 helper
const SIZE_FLOOR = 64 * 1024;

/** 文件头两个字节是 "MZ" 才算 Windows 可执行文件。 */
async function hasMzSignature(filePath) {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.toString("ascii") === "MZ";
  } finally {
    await handle.close();
  }
}

export async function verifyScreenshotHelper(inputPath) {
  const helperPath = path.resolve(inputPath);
  const info = await stat(helperPath);
  if (!info.isFile()) {
    throw new Error(`Screenshot helper is not a file: ${helperPath}`);
  }
  if (info.size <= SIZE_FLOOR) {
    throw new Error(`Screenshot helper is too small (${info.size} bytes): ${helperPath}`);
  }
  if (!(await hasMzSignature(helperPath))) {
    throw new Error(`Screenshot helper is not a Windows executable: ${helperPath}`);
  }
  return { helperPath, size: info.size };
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    throw new Error("Usage: node scripts/verify/screenshot-helper.mjs <path-to-helper.exe>");
  }
  const { helperPath, size } = await verifyScreenshotHelper(target);
  console.log(`[screenshot-helper] verified ${helperPath} (${size} bytes)`);
}

// 只有直接用 node 运行本文件时才执行 main
const runAsScript =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runAsScript) {
  main().catch((error) => {
    console.error(`[screenshot-helper] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
