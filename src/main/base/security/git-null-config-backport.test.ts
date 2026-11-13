import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(path.join(process.cwd(), "package.json"));
const commonjs = require("@simple-git/argv-parser");
const esm = await import("@simple-git/argv-parser");

describe.each([["CommonJS", commonjs], ["ESM", esm]])("Git configuration boundary in %s", (_format, parser) => {
  it("permits only the Windows null device for the explicit global configuration", () => {
    const result = parser.parseEnv({ GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_NOSYSTEM: "1" });
    expect(result.vulnerabilities.length).toBe(process.platform === "win32" ? 0 : 1);
  });

  it.each(["other-config", "NUL/other", "NUL ", "nul", "/dev/null"])("does not grant arbitrary global configuration: %s", target => {
    expect(parser.parseEnv({ GIT_CONFIG_GLOBAL: target }).vulnerabilities).toEqual(expect.arrayContaining([expect.objectContaining({ category: "allowUnsafeConfigPaths" })]));
  });

  it("keeps the system configuration, pager, editor and config injection boundaries", () => {
    for (const env of [{ GIT_CONFIG_SYSTEM: "NUL" }, { GIT_PAGER: "command" }, { GIT_EDITOR: "command" }, { GIT_CONFIG_COUNT: "1" }]) {
      expect(parser.parseEnv(env).vulnerabilities.length).toBeGreaterThan(0);
    }
    expect(parser.parseArgv(["-c", "include.path=other-config", "status"]).vulnerabilities.length).toBeGreaterThan(0);
  });
});
