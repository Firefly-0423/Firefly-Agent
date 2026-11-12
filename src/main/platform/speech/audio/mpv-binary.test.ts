import { beforeEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { detectMpvBinary } from "./mpv-binary";

vi.mock("node:os", () => ({ platform: () => "linux" }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => { vi.resetAllMocks(); });

it("uses an existing system binary without spawning a probe", () => {
  vi.mocked(fs.existsSync).mockReturnValueOnce(true);
  expect(detectMpvBinary()).toBe("/usr/bin/mpv");
  expect(spawnSync).not.toHaveBeenCalled();
});

it("accepts PATH only after a successful bounded probe", () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);
  expect(detectMpvBinary()).toBe("mpv");
  expect(spawnSync).toHaveBeenCalledWith("mpv", ["--version"], { timeout: 5000, windowsHide: true });
});

it("reports an unavailable executable instead of claiming it exists", () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 1 } as never);
  expect(detectMpvBinary()).toBeNull();
});

it("handles a failed probe without spawning a player", () => {
  vi.mocked(spawnSync).mockImplementation(() => { throw new Error("public fixture"); });
  expect(detectMpvBinary()).toBeNull();
});
