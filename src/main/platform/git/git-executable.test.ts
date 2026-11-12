import { it, expect, describe, vi } from "vitest";
import { resolveGitExecutable } from "./git-executable";

describe("Git command selection", () => {
  const embedded = "D:\\Firefly\\bin\\mingit\\git.exe";

  it("returns no selection after both candidates fail their probes", async () => {
    const check = vi.fn().mockResolvedValue(null);
    expect(await resolveGitExecutable({ probe: check, bundledPath: embedded, systemCommand: "git" })).toBeNull();
    expect(check.mock.calls).toEqual([["git"], [embedded]]);
  });

  it("isolates configuration for the fallback executable", async () => {
    const check = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("git version 2.49.2.windows.1");
    const selected = await resolveGitExecutable({ probe: check, bundledPath: embedded, systemCommand: "git" });
    expect(check.mock.calls).toEqual([["git"], [embedded]]);
    expect(selected).toEqual({
      source: "bundled", command: embedded, version: "2.49.2.windows.1",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_NOSYSTEM: "1" },
    });
  });

  it("stops probing as soon as the system executable works", async () => {
    const check = vi.fn().mockResolvedValue("git version 2.48.3.windows.2");
    const selected = await resolveGitExecutable({ probe: check, systemCommand: "git", bundledPath: embedded });
    expect(check.mock.calls).toEqual([["git"]]);
    expect(selected).toEqual({ source: "system", version: "2.48.3.windows.2", command: "git" });
  });
});
