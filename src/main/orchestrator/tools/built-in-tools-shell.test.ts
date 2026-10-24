import { it, expect, describe, beforeAll, afterEach, vi } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { toolRegistry } from "./registry/tool-registry";

describe.runIf(process.platform === "win32")("Windows interpreter selection", () => {
  beforeAll(async () => { await import("./built-in-tools"); });
  afterEach(() => vi.unstubAllEnvs());

  it("offers only cmd and bash and defaults to cmd", () => {
    expect(toolRegistry.getById("run_shell")!.inputSchema.properties.shell).toEqual({
      default: "cmd", enum: ["cmd", "bash"], type: "string", description: expect.any(String),
    });
  });

  it.for(["native path", "slash path"])("runs Bash syntax through the configured executable using %s", async (style, { signal }) => {
    const configured = process.env.FIREFLY_TEST_BASH;
    if (!configured || !path.isAbsolute(configured) || !existsSync(configured) || path.basename(configured) !== "bash.exe") {
      throw new Error("FIREFLY_TEST_BASH must name an existing absolute path to Git Bash bash.exe");
    }
    const executable = style === "slash path" ? configured.replaceAll("\\", "/") : path.normalize(configured);
    vi.stubEnv("PATH", `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`);
    const result = JSON.parse(await toolRegistry.getById("run_shell")!.execute({
      shell: "bash", command: "printf 'interpreter-contract-73'",
    }, { permissionMode: "allow_all", signal } as never));
    expect(result).toMatchObject({ shell: "bash", shellExecutable: path.normalize(executable),
      exitCode: 0, timedOut: false, stdout: "interpreter-contract-73", stderr: "" });
    expect(result.shellExecutable).not.toBe(path.normalize(path.join(path.dirname(executable), "unrelated", "bash.exe")));
    expect(result.shellExecutable).not.toBe(path.normalize(path.join(path.dirname(executable), "cmd.exe")));
  });
});
