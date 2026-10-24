import { spawn } from "node:child_process";
import * as fs from "fs";
import * as path from "node:path";
import { randomUUID } from "crypto";
import { app, BrowserWindow, globalShortcut, nativeImage } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { fireflyEnvironment } from "../../shared/firefly-environment";
import { createIpcScope } from "../application/ipc-scope";
import type { IpcScope } from "../application/ipc-scope";
import { ElectronScreenshotHelperClient } from "./helper-client";
import { resolveScreenshotHelperPath } from "./helper-path";
import { createScreenshotService, validateScreenshotInsert } from "./screenshot-service";
import type { ScreenshotInsertData, ScreenshotService } from "./screenshot-service";

export type { ScreenshotService };

export interface ScreenshotLifecycleOptions {
  capturePetWindow: () => Promise<Electron.NativeImage | null>;
  getReactChatWindow: () => BrowserWindow | null;
  initialHotkey: string;
  /** 可选的共享 scope，便于退出时一并注销；不传则自建。 */
  ipc?: IpcScope;
}

const SCREENSHOT_BYTE_LIMIT = 20 * 1024 * 1024;

function screenshotDirectoryUnderUserData(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

/**
 * 保证 helper 的输出目录存在。WIC 不会自动创建父目录，缺失时会以 0x80070003 失败；
 * mkdir recursive 本身幂等，因此可以反复调用。失败只记录日志，不向上抛出。
 */
async function ensureOutputDirectory(directory: string): Promise<void> {
  await fs.promises
    .mkdir(directory, { recursive: true })
    .catch((error: unknown) => {
      console.error("[Screenshot] 创建截图目录失败:", directory, error);
    });
}

async function persistPastedScreenshot(
  base64: string,
  _mime: string,
): Promise<{ filePath: string }> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > SCREENSHOT_BYTE_LIMIT) throw new Error("SCREENSHOT_TOO_LARGE");

  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("INVALID_SCREENSHOT_IMAGE");

  const directory = screenshotDirectoryUnderUserData();
  await fs.promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, randomUUID() + ".png");
  await fs.promises.writeFile(filePath, image.toPNG());
  return { filePath };
}

export function initializeScreenshotService(
  options: ScreenshotLifecycleOptions,
): ScreenshotService {
  const { getReactChatWindow, capturePetWindow } = options;
  const ipc = options.ipc ?? createIpcScope();
  const outputDirectory = screenshotDirectoryUnderUserData();
  const spawnHelper = (command: string, args: string[]) =>
    spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  // 校验结果并补上可直接显示的 data URL：React 开发页运行在 http://，会拦截 file:// 图片。
  const validateForRenderer = (data: ScreenshotInsertData): ScreenshotInsertData => {
    let decodedPreview: Electron.NativeImage | null = null;
    const accepted = validateScreenshotInsert(data, outputDirectory, (filePath) => {
      decodedPreview = nativeImage.createFromPath(filePath);
      return decodedPreview;
    });
    if (!accepted) throw new Error(`INVALID_SCREENSHOT_RESULT:${data.filePath}`);
    return {
      ...accepted,
      previewUrl: decodedPreview ? (decodedPreview as Electron.NativeImage).toDataURL() : accepted.previewUrl,
    };
  };

  const helperClient = new ElectronScreenshotHelperClient({
    spawnImpl: spawnHelper,
    resolveHelperPath: () => resolveScreenshotHelperPath({
      envOverride: fireflyEnvironment(process.env, "FIREFLY_SCREENSHOT_HELPER_PATH"),
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
    }),
    screenshotDirectory: outputDirectory,
    logger: console,
  });

  // 启动时即建目录，并打印实际输出路径，便于排查路径类错误。
  void ensureOutputDirectory(outputDirectory);
  console.log("[Screenshot] helper output-dir =", outputDirectory);

  const service = createScreenshotService({
    client: helperClient,
    registerShortcut: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    sendInsert: (data) => {
      const payload = validateForRenderer(data);
      const target = getReactChatWindow();
      if (target && !target.isDestroyed()) target.webContents.send(IPC.SCREENSHOT_INSERT, payload);
    },
  });

  ipc.handle(IPC.SCREENSHOT_START, async (event) => {
    // 请求前再次确认目录存在：用户可能清理过 AppData 下的子目录。
    await ensureOutputDirectory(outputDirectory);
    return service.startFromChatButton((data) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(IPC.SCREENSHOT_INSERT, validateForRenderer(data));
    });
  });
  ipc.handle(IPC.SCREENSHOT_SAVE_TEMP, (_event, base64: string, mime: string) => persistPastedScreenshot(base64, mime));
  const toggleHotkey = (suspend: boolean) => () => {
    if (suspend) service.suspendHotkey();
    else service.resumeHotkey();
    return true;
  };
  ipc.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, toggleHotkey(true));
  ipc.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, toggleHotkey(false));

  ipc.handle("debug:screenshot", async () => {
    const snapshot = await capturePetWindow();
    if (!snapshot) return null;
    const png = snapshot.toPNG();
    const target = path.join(app.getPath("temp"), "firefly-screenshot.png");
    fs.writeFileSync(target, png);
    return target;
  });

  service.init(options.initialHotkey);
  return service;
}
