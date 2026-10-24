import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ScreenshotInsertPayload } from "../../shared/ipc-channels";
import type { ScreenshotHelperClient } from "./helper-client";

export type ScreenshotInsertData = ScreenshotInsertPayload;
export type ScreenshotInsertCandidate = Omit<ScreenshotInsertPayload, "previewUrl"> & {
  previewUrl?: string;
};

type HotkeyResult = { ok: boolean; activeHotkey: string | null };
type StartResult = { ok: boolean; reason?: string };

export interface ScreenshotService {
  shutdown(): Promise<void>;
  resumeHotkey(): void;
  suspendHotkey(): void;
  replaceHotkey(next: string): HotkeyResult;
  startFromChatButton(sendInsert?: (data: ScreenshotInsertData) => void): Promise<StartResult>;
  startFromHotkey(): Promise<StartResult>;
  prewarm(): Promise<void>;
  init(initialHotkey: string): void;
}

export interface ScreenshotServiceDeps {
  unregisterShortcut(accelerator: string): void;
  registerShortcut(accelerator: string, callback: () => void): boolean;
  sendInsert(data: ScreenshotInsertData): void;
  client: ScreenshotHelperClient;
}

export interface ScreenshotImageProbe {
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
}

type ServiceOutcome = { ok: boolean; reason?: string };

/** 判断解析后的相对路径是否落在根目录之外（含等于根目录本身的情况）。 */
function leavesDirectory(relative: string): boolean {
  if (relative.length === 0) return true;
  if (relative === "..") return true;
  if (relative.startsWith(`..${path.win32.sep}`)) return true;
  return path.win32.isAbsolute(relative);
}

/** 校验 helper 回传的截图：必须是截图目录内的非空 PNG，且尺寸与报告一致。 */
export function validateScreenshotInsert(
  data: ScreenshotInsertCandidate,
  screenshotDirectory: string,
  loadImage: (filePath: string) => ScreenshotImageProbe,
): ScreenshotInsertData | null {
  const root = path.win32.resolve(screenshotDirectory);
  const filePath = path.win32.resolve(data.filePath);
  if (leavesDirectory(path.win32.relative(root, filePath))) return null;
  if (path.win32.extname(filePath).toLowerCase() !== ".png") return null;

  const probe = loadImage(filePath);
  if (probe.isEmpty()) return null;
  const { width, height } = probe.getSize();
  if (width <= 0 || height <= 0) return null;
  if (width !== data.width || height !== data.height) return null;

  const previewUrl = pathToFileURL(filePath).toString();
  return Object.assign({}, data, { filePath, previewUrl });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "SCREENSHOT_FAILED";
}

export function createScreenshotService(deps: ScreenshotServiceDeps): ScreenshotService {
  let registeredAccelerator: string | null = null;
  let parkedAccelerator: string | null = null;

  const startFromHotkey = async (): Promise<ServiceOutcome> => {
    try {
      await deps.client.start("clipboard-only", "hotkey");
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  };

  const startFromChatButton = async (
    sendInsert: (data: ScreenshotInsertData) => void = deps.sendInsert,
  ): Promise<ServiceOutcome> => {
    try {
      const captured = await deps.client.start("clipboard-and-file", "chat-button");
      if (!captured.filePath) return { ok: false, reason: "SCREENSHOT_FILE_PATH_REQUIRED" };
      sendInsert({
        filePath: captured.filePath,
        width: captured.width,
        height: captured.height,
        mime: captured.mime,
        previewUrl: pathToFileURL(captured.filePath).toString(),
        hasAnnotations: captured.hasAnnotations,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  };

  const tryRegister = (accelerator: string): boolean => {
    const onPress = (): void => {
      void startFromHotkey();
    };
    try {
      return deps.registerShortcut(accelerator, onPress);
    } catch {
      return false;
    }
  };

  const replaceHotkey = (next: string): { ok: boolean; activeHotkey: string | null } => {
    const current = registeredAccelerator;
    if (current === next) return { ok: true, activeHotkey: current };

    if (current) {
      deps.unregisterShortcut(current);
      registeredAccelerator = null;
    }
    if (tryRegister(next)) {
      registeredAccelerator = next;
      return { ok: true, activeHotkey: registeredAccelerator };
    }
    // 新快捷键注册失败时尝试恢复旧的，保证热键不会整体丢失。
    if (current && tryRegister(current)) registeredAccelerator = current;
    return { ok: false, activeHotkey: registeredAccelerator };
  };

  const prewarm = async (): Promise<void> => {
    try {
      await deps.client.ensureStarted();
    } catch (error) {
      // helper 暂不可用不致命，之后 start() 还会再拉起一次。
      console.warn("[Screenshot] native helper prewarm failed:", error);
    }
  };

  return {
    init: (initialHotkey) => {
      replaceHotkey(initialHotkey);
    },
    prewarm,
    startFromHotkey,
    startFromChatButton,
    replaceHotkey,

    suspendHotkey() {
      if (!registeredAccelerator || parkedAccelerator) return;
      parkedAccelerator = registeredAccelerator;
      deps.unregisterShortcut(registeredAccelerator);
      registeredAccelerator = null;
    },

    resumeHotkey() {
      if (!parkedAccelerator) return;
      if (!tryRegister(parkedAccelerator)) return;
      registeredAccelerator = parkedAccelerator;
      parkedAccelerator = null;
    },

    async shutdown() {
      if (registeredAccelerator) deps.unregisterShortcut(registeredAccelerator);
      registeredAccelerator = null;
      parkedAccelerator = null;
      await deps.client.shutdown();
    },
  };
}
