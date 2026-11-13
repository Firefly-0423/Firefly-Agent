import * as path from "node:path";

export type ScreenshotHelperPathEnvironment = {
  envOverride: string | undefined;
  resourcesPath: string;
  appPath: string;
  isPackaged: boolean;
};

const HELPER_BINARY_NAME = "firefly-screenshot.exe";

/** 解析截图 helper 可执行文件：环境变量覆盖优先，其次按打包状态选择资源目录或 Rust release 产物。 */
export function resolveScreenshotHelperPath(environment: ScreenshotHelperPathEnvironment): string {
  const override = environment.envOverride;
  if (override && override.trim() !== "") return override;

  const directorySegments = environment.isPackaged
    ? [environment.resourcesPath, "bin"]
    : [environment.appPath, "native", "target", "release"];
  return path.join(...directorySegments, HELPER_BINARY_NAME);
}
