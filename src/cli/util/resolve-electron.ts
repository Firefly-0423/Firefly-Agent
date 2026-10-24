import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fireflyEnvironment } from "../../shared/firefly-environment";

/**
 * 确定 `firefly run` 要启动的 Electron 可执行文件。
 * 优先用项目本地 node_modules/.bin 里的，这样 PATH 上没有 electron 也能运行；
 * 找不到再看 FIREFLY_ELECTRON_BIN，最后回退到裸命令 electron。
 */
export function resolveElectron(projectRoot: string): string {
  const executable = process.platform === "win32" ? "electron.cmd" : "electron";
  const candidate = path.join(projectRoot, "node_modules", ".bin", executable);
  return existsSync(candidate)
    ? candidate
    : (fireflyEnvironment(process.env, "FIREFLY_ELECTRON_BIN") ?? "electron");
}
