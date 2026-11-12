import { expect, it, describe } from "vitest";
import { resolveScreenshotHelperPath } from "./helper-path";

describe("Native capture binary location", () => {
  it("honors a supplied executable regardless of packaging", () => {
    for (const packaged of [false, true]) {
      expect(resolveScreenshotHelperPath({ isPackaged: packaged, envOverride: "F:\\capture-tools\\custom.exe",
        resourcesPath: "D:\\Firefly\\resources", appPath: "D:\\checkout" })).toEqual("F:\\capture-tools\\custom.exe");
    }
  });

  it.runIf(process.platform === "win32")("selects the binary relative to the applicable installation root", () => {
    const paths = { resourcesPath: "D:\\Firefly\\resources", appPath: "D:\\checkout", envOverride: undefined };
    const unpacked = resolveScreenshotHelperPath({ ...paths, isPackaged: false });
    const installed = resolveScreenshotHelperPath({ ...paths, isPackaged: true });
    expect([unpacked, installed]).toEqual([
      "D:\\checkout\\native\\target\\release\\firefly-screenshot.exe",
      "D:\\Firefly\\resources\\bin\\firefly-screenshot.exe",
    ]);
  });
});
