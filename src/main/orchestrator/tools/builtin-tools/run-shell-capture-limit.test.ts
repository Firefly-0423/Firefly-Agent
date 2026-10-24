import { describe, it, expect, beforeAll } from "vitest";
import { toolRegistry } from "../registry/tool-registry";

describe.runIf(process.platform === "win32")("foreground output capture contract", () => {
  beforeAll(async () => { await import("../built-in-tools"); });
  async function execute(script: string) {
    const text = await toolRegistry.getById("run_shell")!.execute({ command: `node -e "${script}"` }, { permissionMode: "allow_all" } as never);
    return { text, result: JSON.parse(text) };
  }
  it("keeps a forty-kilobyte report including the final summary", async () => {
    const { result } = await execute("process.stdout.write('r'.repeat(40960)+'REPORT_FINISHED_73')");
    expect(result.exitCode).toBe(0);
    expect(result.captureTruncated).toBe(false);
    expect(result.stdout.endsWith("REPORT_FINISHED_73")).toBe(true);
    expect(result.stdout.length).toBeGreaterThanOrEqual(40960);
  });
  it("stops storing stdout after its two-megabyte budget is crossed", async () => {
    const { result } = await execute("process.stdout.write(Buffer.alloc(3*1024*1024,114))");
    expect(result.exitCode).toBe(0);
    expect(result.captureTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 8192);
    expect(result.stdout.length).toBeGreaterThan(1024 * 1024);
  });
  it("retains stderr independently of a stdout flood", async () => {
    const { result } = await execute("process.stdout.write(Buffer.alloc(3*1024*1024,114));process.stderr.write('DIAGNOSTIC_RETAINED_73')");
    expect(result.captureTruncated).toBe(true);
    expect(result.stderr).toContain("DIAGNOSTIC_RETAINED_73");
  });
  it("places stderr before the final stdout property in both object and wire text", async () => {
    const { result, text } = await execute("console.log('wire-order-73')");
    const properties = Object.keys(result);
    expect(properties.at(-1)).toBe("stdout");
    expect(properties.indexOf("stderr")).toBeLessThan(properties.indexOf("stdout"));
    expect(text.indexOf('"stderr"')).toBeLessThan(text.indexOf('"stdout"'));
  });
});
