import { EventEmitter } from "node:events";
import { vi, beforeAll, beforeEach, afterEach, it, expect, describe } from "vitest";
import { toolRegistry } from "./registry/tool-registry";
import { executeToolDefinition } from "./registry/tool-executor";

const processes = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("child_process", () => ({ spawn: processes.launch }));
const processDouble = (pid: number) => Object.assign(new EventEmitter(), {
  pid, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
});
type ProcessDouble = ReturnType<typeof processDouble>;

describe.runIf(process.platform === "win32")("foreground shell deadline reporting", () => {
  let running: ProcessDouble;
  let serial = 7300;
  beforeAll(async () => { await import("./built-in-tools"); });
  beforeEach(() => {
    vi.useFakeTimers();
    processes.launch.mockReset().mockImplementation((executable: string) => {
      const child = processDouble(serial++);
      if (executable.toLowerCase() !== "taskkill") running = child;
      return child;
    });
  });
  afterEach(() => vi.useRealTimers());

  async function launch(command: string, timeout_ms?: number) {
    const outcome = executeToolDefinition(toolRegistry.getById("run_shell")!, {
      command, ...(timeout_ms === undefined ? {} : { timeout_ms }),
    }, { permissionMode: "allow_all" } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toBeDefined();
    return { outcome };
  }
  const expectTimeout = (result: Awaited<ReturnType<typeof executeToolDefinition>>) => {
    expect(result).toMatchObject({ status: "failed", errorCode: "E_TOOL_TIMEOUT", category: "timeout" });
    expect(JSON.parse(result.output)).toMatchObject({ timedOut: true, exitCode: null });
  };

  it("waits through idle detection and the entire cleanup grace period when close is absent", async () => {
    const { outcome } = await launch("preview-server --port 7381");
    let complete = false;
    void outcome.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await outcome;
    expectTimeout(result);
    expect(result.effectState).toBe("unknown");
    expect(JSON.parse(result.output).command).toBe("preview-server --port 7381");
    expect(processes.launch).toHaveBeenCalledWith("taskkill", ["/pid", String(running.pid), "/T", "/F"], expect.objectContaining({ shell: false }));
  });

  it("renews the idle window after stdout and permits normal completion", async () => {
    const { outcome } = await launch("compile-project");
    let complete = false;
    void outcome.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(119_999);
    running.stdout.emit("data", Buffer.from("compilation progressing"));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(complete).toBe(false);
    running.emit("close", 0);
    const result = await outcome;
    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.output)).toMatchObject({ exitCode: 0, stdout: "compilation progressing", timedOut: false });
  });

  it("enforces thirty minutes even with recurring progress", async () => {
    const { outcome } = await launch("continuous-progress");
    const pulse = setInterval(() => running.stdout.emit("data", Buffer.from("+")), 60_000);
    await vi.advanceTimersByTimeAsync(1_800_000);
    clearInterval(pulse);
    await vi.advanceTimersByTimeAsync(2_000);
    expectTimeout(await outcome);
  });

  it("replaces idle detection with an explicit five-minute deadline", async () => {
    const { outcome } = await launch("quiet-compilation", 300_000);
    let complete = false;
    void outcome.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(172_000);
    const result = await outcome;
    expectTimeout(result);
    expect(JSON.parse(result.output).stderr).toContain("timeout_ms=300000 毫秒执行上限");
  });

  it("retains timeout facts when process close beats the cleanup grace deadline", async () => {
    const { outcome } = await launch("quiet-preview");
    await vi.advanceTimersByTimeAsync(121_000);
    running.emit("close", 1);
    const result = await outcome;
    expectTimeout(result);
    const stderr = JSON.parse(result.output).stderr;
    expect(stderr).toContain("[已终止]");
    expect(stderr).toContain("无任何输出");
  });
});
