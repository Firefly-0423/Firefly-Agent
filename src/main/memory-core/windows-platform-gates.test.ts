import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { resolveRuntimeProfile } from "../runtime-profile";
import { createStorageContext } from "../storage-context";
import { windowsHelperConfig, acquireMemoryOpenLease } from "./windows-open-lock";
import { acquireWriterOwnership } from "./writer-ownership";
import { createWindowsKeyProtection } from "./windows-dpapi";
import { loadOrCreateMemoryKey } from "./protected-key";
import { MemoryClient } from "./worker-client";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => { throw new Error("UNEXPECTED_HELPER"); }) }));

// Exercise the actual fail-closed platform gates, never spoof process.platform or
// replace kernel ownership with a Linux lock to make Windows integration green.
describe.runIf(process.platform !== "win32")("non-Windows native memory denial", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-platform-gate-")); });
  afterEach(() => {
    try {
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.readdirSync(root)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); }
  });
  const protection = () => ({ protect: vi.fn(), unprotect: vi.fn() });

  it("rejects trusted helper configuration and DPAPI before creating temp directories", () => {
    expect(() => windowsHelperConfig(path.join(root, "temp"))).toThrow("MEMORY_WINDOWS_REQUIRED");
    expect(() => createWindowsKeyProtection(path.join(root, "temp"))).toThrow("MEMORY_WINDOWS_REQUIRED");
  });

  it("rejects publication and writer leases before spawning or creating a kernel endpoint", async () => {
    await expect(acquireMemoryOpenLease(path.join(root, "data"), path.join(root, "temp"))).rejects.toThrow("MEMORY_WINDOWS_REQUIRED");
    await expect(acquireWriterOwnership(path.join(root, "data"))).rejects.toThrow("MEMORY_WINDOWS_REQUIRED");
  });

  it("rejects key publication before protecting plaintext or writing a key record", async () => {
    const keyProtection = protection();
    await expect(loadOrCreateMemoryKey({
      roots: { dataRoot: path.join(root, "data"), indexRoot: path.join(root, "index"), tempRoot: path.join(root, "temp") },
      protection: keyProtection,
    })).rejects.toThrow("MEMORY_WINDOWS_REQUIRED");
    expect(keyProtection.protect).not.toHaveBeenCalled();
    expect(keyProtection.unprotect).not.toHaveBeenCalled();
  });

  it("rejects a real MemoryClient before key protection or Worker construction", async () => {
    const isolation = path.join(root, "isolated");
    fs.mkdirSync(isolation);
    try {
      const storage = createStorageContext(resolveRuntimeProfile({
        argv: ["--firefly-profile=test", "--firefly-isolation-root=" + isolation],
        env: {}, isPackaged: false, productionAppData: path.join(root, "synthetic-production"),
      }));
      const keyProtection = protection(), workerFactory = vi.fn();
      await expect(MemoryClient.open({ storage, keyProtection, workerFactory })).rejects.toThrow("MEMORY_WINDOWS_REQUIRED");
      expect(keyProtection.protect).not.toHaveBeenCalled();
      expect(keyProtection.unprotect).not.toHaveBeenCalled();
      expect(workerFactory).not.toHaveBeenCalled();
      expect(fs.readdirSync(isolation)).toEqual([]);
    } finally { fs.rmSync(isolation, { recursive: true, force: true }); }
  });
});
