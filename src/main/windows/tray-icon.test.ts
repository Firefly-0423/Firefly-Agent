import path from "node:path";
import fs from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
const { createFromPath } = vi.hoisted(() => ({ createFromPath: vi.fn() }));
vi.mock("electron", () => ({ app: { getAppPath: () => "public-app" }, nativeImage: { createFromPath } }));
import { loadTrayIcon } from "./tray-icon";
beforeEach(() => createFromPath.mockReset());
it("loads the same packaged asset path for the tray", () => {
  const loaded = { isEmpty: () => false };
  createFromPath.mockReturnValue(loaded);
  expect(loadTrayIcon()).toBe(loaded);
  expect(createFromPath).toHaveBeenCalledExactlyOnceWith(path.join("public-app", "assets", "tray-icon.ico"));
});
it("falls back only to the verified Firefly PNG", () => {
  const fallback = { isEmpty: () => false };
  createFromPath.mockReturnValueOnce({ isEmpty: () => true }).mockReturnValueOnce(fallback);
  expect(loadTrayIcon()).toBe(fallback);
  expect(createFromPath).toHaveBeenLastCalledWith(path.join("public-app", "assets", "icon-presets", "firefly.png"));
});
it("contains all nine required ICO frame sizes", () => {
  const icon = fs.readFileSync(path.resolve(__dirname, "../../../assets/tray-icon.ico"));
  expect(icon.readUInt16LE(2)).toBe(1);
  expect(icon.readUInt16LE(4)).toBe(9);
  const sizes = Array.from({ length: 9 }, (_, index) => [icon[6 + index * 16] || 256, icon[7 + index * 16] || 256]);
  expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256].map(size => [size, size]));
});
