import { beforeAll, describe, it, expect } from "vitest";
import { resolveTimeoutPolicy } from "./run-shell-tool";
import { toolRegistry } from "../registry/tool-registry";

describe("shell deadline input normalization", () => {
  it.each([undefined, null, "", "abc", true, false, {}, Number.NaN])("uses idle and total defaults for %j", (raw) => {
    expect(resolveTimeoutPolicy(raw)).toEqual({ idleMs: 120_000, totalMs: 1_800_000, explicitDeadline: false });
  });
  it.each([5000, "5000", 5000.4])("accepts and rounds a numeric deadline %j", (raw) => {
    expect(resolveTimeoutPolicy(raw)).toEqual({ idleMs: undefined, totalMs: 5000, explicitDeadline: true });
  });
  it.each([0, -50, 100, 999])("clamps %s upward to one second", (raw) => {
    expect(resolveTimeoutPolicy(raw).totalMs).toBe(1000);
  });
  it.each([99_999_999, 10 * 60_000 * 60])("clamps %s downward to thirty minutes", (raw) => {
    expect(resolveTimeoutPolicy(raw).totalMs).toBe(1_800_000);
  });
  it("turns off idle detection for a five-minute explicit execution limit", () => {
    expect(resolveTimeoutPolicy(300_000)).toEqual({ idleMs: undefined, totalMs: 300_000, explicitDeadline: true });
  });
});

describe.runIf(process.platform === "win32")("real shell execution deadlines", () => {
  beforeAll(async () => { await import("../built-in-tools"); });
  const execute = async (script: string, timeout_ms: number) => JSON.parse(await toolRegistry.getById("run_shell")!.execute({
    command: `node -e "${script}"`, timeout_ms,
  }, { permissionMode: "allow_all" } as never));

  it("kills a ten-second silent process at three seconds and explains how to retry", async () => {
    const started = Date.now();
    const result = await execute("setTimeout(()=>process.exit(0),10000)", 3000);
    const duration = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timeout_ms=3000 毫秒执行上限");
    expect(result.stderr).toContain("增大 timeout_ms");
    expect(duration).toBeGreaterThanOrEqual(2900);
    expect(duration).toBeLessThan(8000);
  }, 20_000);
  it("reports the clamped one-second deadline for a too-small request", async () => {
    const result = await execute("setTimeout(()=>process.exit(0),2000)", 100);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("timeout_ms=1000 毫秒执行上限");
  }, 15_000);
  it("lets four seconds of silence finish within a fifteen-second limit", async () => {
    const result = await execute("setTimeout(()=>process.exit(0),4000)", 15000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 20_000);
});
