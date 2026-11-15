import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initializeMainFileLogging, logger, resolveDefaultLogLevel } from "./logger";
import { resolveRuntimeProfile } from "../identity/runtime-profile";
import { initializeStorageContext } from "../storage/storage-context";

describe("main file logging", () => {
  it("installs into the explicitly configured userData directory", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-logging-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const profile = resolveRuntimeProfile({
      argv: ["--firefly-profile=test", `--firefly-isolation-root=${userDataDir}`],
      env: {},
      isPackaged: false,
      productionAppData: path.join(os.tmpdir(), "firefly-production-fixture"),
    });
    const storage = initializeStorageContext(profile);
    const uninstall = initializeMainFileLogging();
    try {
      logger.warn("Runtime", "startup chats index", { sessionCount: 2 });
      const output = fs.readFileSync(storage.files.mainLog, "utf8");
      expect(output).toContain("sessionCount");
      expect(output).not.toContain("model-settings.json");
    } finally {
      uninstall();
      stderr.mockRestore();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

describe("default log level", () => {
  it.each([
    { build: "development", isPackaged: false, env: {}, level: "info" },
    { build: "installed", isPackaged: true, env: {}, level: "warn" },
    { build: "unknown (no Electron app)", isPackaged: undefined, env: {}, level: "warn" },
    { build: "installed with FIREFLY_LOG_LEVEL=debug", isPackaged: true, env: { FIREFLY_LOG_LEVEL: "DEBUG" }, level: "debug" },
    { build: "development with FIREFLY_LOG_LEVEL=error", isPackaged: false, env: { FIREFLY_LOG_LEVEL: "error" }, level: "error" },
    { build: "development with an invalid FIREFLY_LOG_LEVEL", isPackaged: false, env: { FIREFLY_LOG_LEVEL: "loud" }, level: "info" },
  ])("uses $level for a $build build", ({ isPackaged, env, level }) => {
    expect(resolveDefaultLogLevel(env, isPackaged)).toBe(level);
  });
});
