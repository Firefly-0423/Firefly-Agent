import { describe, it, expect, vi } from "vitest";
vi.mock("../../shell-runtime", async (original) => ({
  ...await original<typeof import("../../shell-runtime")>(),
  resolveShellExecutable: async (kind: "cmd" | "bash") => kind === "bash" ? null : { kind, executable: process.env.ComSpec || "cmd.exe" },
}));
import { runShellTool } from "./run-shell-tool";
const run = async (args: Record<string, unknown>, context: unknown = { permissionMode: "allow_all" }) =>
  JSON.parse(await runShellTool.execute(args, context as never));
const node = (script: string) => ({ command: `node -e "${script}"` });

describe.runIf(process.platform === "win32")("shell input and stream edge cases", () => {
  it("rejects PowerShell as an unsupported interpreter", async () => {
    const result = await run({ command: "echo contract-73", shell: "powershell" });
    expect(result).toMatchObject({ errorCode: "SHELL_UNSUPPORTED", exitCode: -1, stdout: "" });
    expect(result.stderr).toContain("仅支持 cmd 或 bash");
  });
  it("rejects shutdown even under full trust", async () => {
    const result = await run({ command: "shutdown /s /t 0", shell: "cmd" });
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("该命令被系统禁止执行");
  });
  it("returns an unavailable-Bash failure instead of using cmd", async () => {
    const result = await run({ shell: "bash", command: "pwd" });
    expect(result).toMatchObject({ errorCode: "BASH_UNAVAILABLE", shell: "bash", exitCode: -1, stdout: "" });
    expect(result.stderr).toContain("未找到可用的 Bash");
  });
  it("decodes a GBK character after strict UTF-8 decoding fails", async () => {
    const result = await run(node("process.stdout.write(Buffer.from([214,208]))"));
    expect(result).toMatchObject({ exitCode: 0, captureTruncated: false, stdout: "中" });
  });
  it("caps stderr without retaining a three-megabyte stream", async () => {
    const result = await run(node("process.stderr.write(Buffer.alloc(3*1024*1024,115))"));
    expect(result).toMatchObject({ exitCode: 0, captureTruncated: true });
    expect(result.stderr.length).toBeGreaterThan(1024 * 1024);
    expect(result.stderr.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 8192);
  });
  it("reports cancellation when the run was aborted before launch", async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const result = await run(node("setTimeout(()=>{},4000)"), { permissionMode: "allow_all", signal: cancellation.signal });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("所在任务已被用户取消");
  });
  it("allows an active abort signal to coexist with successful completion", async () => {
    const result = await run(node("console.log('signal-allowed-73')"), { permissionMode: "allow_all", signal: new AbortController().signal });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain("signal-allowed-73");
  });
});
