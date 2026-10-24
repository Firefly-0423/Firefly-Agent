import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initializeMainFileLogging, logger } from "./logger";
import { resolveRuntimeProfile } from "./runtime-profile";
import { initializeStorageContext } from "./storage-context";

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
