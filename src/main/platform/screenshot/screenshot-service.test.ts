import { describe, it, expect, vi } from "vitest";
import { createScreenshotService, validateScreenshotInsert, type ScreenshotServiceDeps } from "./screenshot-service";
import type { ScreenshotResult } from "./helper-client";

function captured(extra: Partial<ScreenshotResult> = {}): ScreenshotResult {
  return { width: 1024, height: 512, mime: "image/png", filePath: null, hasAnnotations: false,
    clipboardWritten: true, requestId: "capture-94", ...extra };
}

function wiredCapture() {
  const bindings = new Map<string, () => void>();
  const client: ScreenshotServiceDeps["client"] = {
    processState: "stopped", captureState: "idle", pendingRequests: new Map(),
    ensureStarted: vi.fn().mockResolvedValue(undefined), shutdown: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(), cancel: vi.fn(),
  };
  const insert = vi.fn();
  const bind = vi.fn((key: string, action: () => void) => { bindings.set(key, action); return true; });
  const unbind = vi.fn((key: string) => { bindings.delete(key); });
  const api = createScreenshotService({ client, sendInsert: insert, registerShortcut: bind, unregisterShortcut: unbind });
  return { api, client, insert, bind, unbind, bindings };
}

describe("Capture shortcut registration", () => {
  it("parks and restores the active shortcut while another control captures keys", () => {
    const port = wiredCapture();
    port.api.init("Control+Alt+P");
    expect([...port.bindings.keys()]).toEqual(["Control+Alt+P"]);
    port.api.suspendHotkey();
    expect([...port.bindings.keys()]).toEqual([]);
    port.api.resumeHotkey();
    expect([...port.bindings.keys()]).toEqual(["Control+Alt+P"]);
  });

  it.each(["refused", "throws"] as const)("restores the old accelerator when registration %s", (failure) => {
    const port = wiredCapture();
    port.api.init("Control+Alt+P");
    port.bind.mockImplementationOnce(() => {
      if (failure === "throws") throw new Error("unsupported accelerator");
      return false;
    });
    expect(() => {
      expect(port.api.replaceHotkey("invalid replacement")).toEqual({ activeHotkey: "Control+Alt+P", ok: false });
    }).not.toThrow();
    expect([...port.bindings.keys()]).toEqual(["Control+Alt+P"]);
    expect(port.bind.mock.calls.map(([key]) => key)).toEqual(["Control+Alt+P", "invalid replacement", "Control+Alt+P"]);
    expect(port.unbind).toHaveBeenCalledExactlyOnceWith("Control+Alt+P");
    expect(port.api.replaceHotkey("Control+Alt+P")).toEqual({ activeHotkey: "Control+Alt+P", ok: true });
    expect(port.bind).toHaveBeenCalledTimes(3);
  });
});

describe("Capture entry points", () => {
  it("keeps a hotkey capture exclusively on the clipboard", async () => {
    const port = wiredCapture();
    vi.mocked(port.client.start).mockResolvedValue(captured());
    expect(await port.api.startFromHotkey()).toEqual({ ok: true });
    expect(port.client.start).toHaveBeenCalledExactlyOnceWith("clipboard-only", "hotkey");
    expect(port.insert).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("sends the chat capture with the complete image preview payload", async () => {
    const port = wiredCapture();
    vi.mocked(port.client.start).mockResolvedValue(captured({ filePath: "D:\\captures\\toolbar.png", hasAnnotations: true }));
    expect(await port.api.startFromChatButton()).toEqual({ ok: true });
    expect(port.client.start).toHaveBeenCalledExactlyOnceWith("clipboard-and-file", "chat-button");
    expect(port.insert.mock.calls).toEqual([[{ width: 1024, height: 512, mime: "image/png", hasAnnotations: true,
      filePath: "D:\\captures\\toolbar.png", previewUrl: "file:///D:/captures/toolbar.png" }]]);
  });

  it("routes a requested insertion to the requesting renderer", async () => {
    const port = wiredCapture();
    const reply = vi.fn();
    vi.mocked(port.client.start).mockResolvedValue(captured({ filePath: "D:\\captures\\request.png" }));
    expect(await port.api.startFromChatButton(reply)).toEqual({ ok: true });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(port.insert).not.toHaveBeenCalled();
  });

  it("reports a missing chat capture file without inserting anything", async () => {
    const port = wiredCapture();
    vi.mocked(port.client.start).mockResolvedValue(captured());
    expect(await port.api.startFromChatButton()).toEqual({ reason: "SCREENSHOT_FILE_PATH_REQUIRED", ok: false });
    expect(port.insert).not.toHaveBeenCalled();
  });

  it("warns about helper prewarm failure while allowing startup to continue", async () => {
    const port = wiredCapture();
    const failure = new Error("capture binary absent");
    vi.mocked(port.client.ensureStarted).mockRejectedValue(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(port.api.prewarm()).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledExactlyOnceWith("[Screenshot] native helper prewarm failed:", failure);
    } finally { warning.mockRestore(); }
  });
});

describe("Renderer image validation", () => {
  const root = "D:\\profile\\screenshots";
  const image = { filePath: `${root}\\panel.png`, width: 1024, height: 512, mime: "image/png" as const, hasAnnotations: false };

  it.runIf(process.platform === "win32")("accepts a nonempty PNG with matching dimensions", () => {
    const accepted = validateScreenshotInsert(image, root, () => ({ isEmpty: () => false, getSize: () => ({ width: 1024, height: 512 }) }));
    expect(accepted).toEqual({ ...image, previewUrl: "file:///D:/profile/screenshots/panel.png" });
  });

  it("rejects a sibling path before decoding and rejects a dimension mismatch after decoding", () => {
    const decode = vi.fn(() => ({ isEmpty: () => false, getSize: () => ({ width: 300, height: 200 }) }));
    expect(validateScreenshotInsert({ ...image, filePath: "D:\\profile\\elsewhere\\panel.png" }, root, decode)).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    expect(validateScreenshotInsert(image, root, decode)).toBeNull();
    expect(decode).toHaveBeenCalledExactlyOnceWith(image.filePath);
  });

  it.runIf(process.platform === "win32")("allows a dot prefix that is part of the basename", () => {
    const dotted = { ...image, filePath: `${root}\\..panel.png`, width: 32, height: 16 };
    expect(validateScreenshotInsert(dotted, root, () => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 16 }) })))
      .toEqual({ ...dotted, previewUrl: "file:///D:/profile/screenshots/..panel.png" });
  });
});
