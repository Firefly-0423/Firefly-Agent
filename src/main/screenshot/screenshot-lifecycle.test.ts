import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcScope } from "../application/ipc-scope";

const h = vi.hoisted(() => {
  const state = {
    root: "",
    userData: "",
    temp: "",
    sent: [] as unknown[][],
    startResult: {} as Record<string, unknown>,
    captureResult: null as unknown,
    emptyImage: false,
    image: {
      isEmpty: () => false,
      toPNG: () => Buffer.from("PNG"),
      toDataURL: () => "data:image/png;base64,AAAA",
      getSize: () => ({ width: 800, height: 600 }),
    },
    empty: { isEmpty: () => true, toPNG: () => Buffer.alloc(0), toDataURL: () => "", getSize: () => ({ width: 0, height: 0 }) },
    createFromBuffer: undefined as unknown as ReturnType<typeof vi.fn>,
    createFromPath: undefined as unknown as ReturnType<typeof vi.fn>,
    register: vi.fn(() => true),
    unregister: vi.fn(),
    clientOptions: undefined as unknown,
  };
  state.createFromBuffer = vi.fn(() => (state.emptyImage ? state.empty : state.image));
  state.createFromPath = vi.fn(() => (state.emptyImage ? state.empty : state.image));
  return state;
});

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => h.root,
    getPath: (name: string) => {
      if (name === "userData") return h.userData;
      if (name === "temp") return h.temp;
      return h.root;
    },
  },
  nativeImage: {
    createFromBuffer: h.createFromBuffer,
    createFromPath: h.createFromPath,
  },
  globalShortcut: {
    register: h.register,
    unregister: h.unregister,
  },
}));

vi.mock("./helper-client", () => ({
  ElectronScreenshotHelperClient: class {
    constructor(options: unknown) { h.clientOptions = options; }
    ensureStarted = async () => {};
    start = async () => h.startResult;
    shutdown = async () => {};
    cancel = () => {};
  },
}));

import { initializeScreenshotService } from "./screenshot-lifecycle";
import { IPC } from "../../shared/ipc-channels";

type Handler = (...args: never[]) => unknown;
const handlers = new Map<string, Handler>();
const ipc = {
  handle: vi.fn((channel: string, listener: Handler) => { handlers.set(channel, listener); }),
  removeHandler: vi.fn(),
  on: vi.fn(),
  dispose: vi.fn(),
} as unknown as IpcScope;

type Sender = { isDestroyed: () => boolean; send: (...args: unknown[]) => void };

let sender: Sender;
let chatWindow: { isDestroyed: () => boolean; webContents: { send: (...args: unknown[]) => void } } | null;

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-screenshot-root-"));
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-screenshot-user-"));
  h.temp = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-screenshot-temp-"));
  h.sent.length = 0;
  h.emptyImage = false;
  h.captureResult = null;
  h.register.mockClear();
  h.register.mockReturnValue(true);
  h.unregister.mockClear();
  h.createFromBuffer.mockClear();
  h.createFromPath.mockClear();
  h.startResult = {
    requestId: "request-1",
    filePath: path.join(h.userData, "screenshots", "shot.png"),
    width: 800,
    height: 600,
    mime: "image/png",
    clipboardWritten: true,
    hasAnnotations: true,
  };
  handlers.clear();
  sender = { isDestroyed: () => false, send: (...args) => { h.sent.push(args); } };
  chatWindow = { isDestroyed: () => false, webContents: { send: (...args) => { h.sent.push(args); } } };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.rmSync(h.userData, { recursive: true, force: true });
  fs.rmSync(h.temp, { recursive: true, force: true });
});

function initialize() {
  return initializeScreenshotService({
    initialHotkey: "Ctrl+Shift+S",
    getReactChatWindow: () => chatWindow as never,
    capturePetWindow: async () => h.captureResult as never,
    ipc,
  });
}

async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return await (handler as (...values: unknown[]) => T)(...args);
}

describe("initializeScreenshotService", () => {
  it("registers the initial hotkey and every screenshot IPC handler", () => {
    const service = initialize();
    expect(service).toBeDefined();
    expect(h.register).toHaveBeenCalledWith("Ctrl+Shift+S", expect.any(Function));
    expect(h.register.mock.calls[0][0]).toBe("Ctrl+Shift+S");
    expect([...handlers.keys()].sort()).toEqual([
      "debug:screenshot",
      IPC.SCREENSHOT_HOTKEY_CAPTURE_END,
      IPC.SCREENSHOT_HOTKEY_CAPTURE_START,
      IPC.SCREENSHOT_SAVE_TEMP,
      IPC.SCREENSHOT_START,
    ].sort());
    expect(h.clientOptions).toMatchObject({
      screenshotDirectory: path.join(h.userData, "screenshots"),
    });
  });

  it("creates the screenshot directory before starting a capture", async () => {
    initialize();
    const directory = path.join(h.userData, "screenshots");
    // initialize() creates the directory in the background; let that mkdir settle before removing it.
    await vi.waitFor(() => expect(fs.existsSync(directory)).toBe(true));
    fs.rmSync(directory, { recursive: true, force: true });
    expect(fs.existsSync(directory)).toBe(false);
    await call(IPC.SCREENSHOT_START, { sender });
    expect(fs.existsSync(directory)).toBe(true);
  });

  it("saves a valid pasted image to the screenshots directory", async () => {
    initialize();
    const result = await call<{ filePath: string }>(
      IPC.SCREENSHOT_SAVE_TEMP,
      {},
      Buffer.from("raw-image").toString("base64"),
      "image/png",
    );
    expect(path.dirname(result.filePath)).toBe(path.join(h.userData, "screenshots"));
    expect(path.extname(result.filePath)).toBe(".png");
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("PNG");
  });

  it("rejects an empty decoded image", async () => {
    h.emptyImage = true;
    initialize();
    await expect(
      call(IPC.SCREENSHOT_SAVE_TEMP, {}, Buffer.from("raw").toString("base64"), "image/png"),
    ).rejects.toThrow("INVALID_SCREENSHOT_IMAGE");
  });

  it("rejects a decoded image larger than 20 MiB before decoding it as an image", async () => {
    initialize();
    const oversize = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(
      call(IPC.SCREENSHOT_SAVE_TEMP, {}, oversize.toString("base64"), "image/png"),
    ).rejects.toThrow("SCREENSHOT_TOO_LARGE");
    expect(h.createFromBuffer).not.toHaveBeenCalled();
  });

  it("validates a chat-button screenshot and sends it to the requesting renderer", async () => {
    initialize();
    const result = await call<{ ok: boolean }>(IPC.SCREENSHOT_START, { sender });
    expect(result).toEqual({ ok: true });
    expect(h.sent).toEqual([[IPC.SCREENSHOT_INSERT, {
      filePath: path.win32.resolve(h.startResult.filePath as string),
      width: 800,
      height: 600,
      mime: "image/png",
      previewUrl: "data:image/png;base64,AAAA",
      hasAnnotations: true,
    }]]);
  });

  it("does not send a screenshot when the requesting sender was destroyed", async () => {
    initialize();
    const result = await call<{ ok: boolean }>(IPC.SCREENSHOT_START, {
      sender: { isDestroyed: () => true, send: sender.send },
    });
    expect(result).toEqual({ ok: true });
    expect(h.sent).toEqual([]);
  });

  it("returns a failure when the helper produces no file path", async () => {
    h.startResult = { ...h.startResult, filePath: null };
    initialize();
    await expect(call(IPC.SCREENSHOT_START, { sender })).resolves.toEqual({
      ok: false,
      reason: "SCREENSHOT_FILE_PATH_REQUIRED",
    });
    expect(h.sent).toEqual([]);
  });

  it("refuses a screenshot file outside the owned directory", async () => {
    h.startResult = { ...h.startResult, filePath: path.join(os.tmpdir(), "outside-shot.png") };
    initialize();
    await expect(call(IPC.SCREENSHOT_START, { sender })).resolves.toEqual({
      ok: false,
      reason: `INVALID_SCREENSHOT_RESULT:${h.startResult.filePath}`,
    });
    expect(h.sent).toEqual([]);
  });

  it("suspends and resumes the hotkey around capture", async () => {
    initialize();
    h.register.mockClear();
    h.unregister.mockClear();

    await expect(call(IPC.SCREENSHOT_HOTKEY_CAPTURE_START)).resolves.toBe(true);
    expect(h.unregister).toHaveBeenCalledWith("Ctrl+Shift+S");

    await expect(call(IPC.SCREENSHOT_HOTKEY_CAPTURE_END)).resolves.toBe(true);
    expect(h.register).toHaveBeenCalledWith("Ctrl+Shift+S", expect.any(Function));
  });

  it("does not unregister when hotkey capture starts twice", async () => {
    initialize();
    h.unregister.mockClear();
    await call(IPC.SCREENSHOT_HOTKEY_CAPTURE_START);
    await call(IPC.SCREENSHOT_HOTKEY_CAPTURE_START);
    expect(h.unregister).toHaveBeenCalledTimes(1);
  });

  it("returns null from the debug capture when the pet window cannot be captured", async () => {
    initialize();
    await expect(call("debug:screenshot")).resolves.toBeNull();
  });

  it("writes and returns a debug capture in the temp directory", async () => {
    h.captureResult = { toPNG: () => Buffer.from("CAPTURE") };
    initialize();
    const output = await call<string>("debug:screenshot");
    expect(output).toBe(path.join(h.temp, "firefly-screenshot.png"));
    expect(fs.readFileSync(output, "utf8")).toBe("CAPTURE");
  });
});
