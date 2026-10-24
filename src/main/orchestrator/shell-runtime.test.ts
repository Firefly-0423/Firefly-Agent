import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), existsSync: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("fs", () => ({ default: { existsSync: mocks.existsSync } }));

import { resolveShellExecutable } from "./shell-runtime";

class ProbeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly kill = vi.fn();
}

const firstPath = path.resolve("fixtures", "bash-first", "bash.exe");
const secondPath = path.resolve("fixtures", "bash-second", "bash.exe");

beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.existsSync.mockReset();
  vi.stubEnv("PATH", [path.dirname(firstPath), path.dirname(secondPath)].join(path.delimiter));
  vi.stubEnv("ProgramFiles", "");
  vi.stubEnv("ProgramFiles(x86)", "");
  vi.stubEnv("LOCALAPPDATA", "");
  mocks.existsSync.mockImplementation((file: string) => file === firstPath || file === secondPath);
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Bash executable probing", () => {
  it("requires the expected output and successful close before selecting a shell", async () => {
    const child = new ProbeProcess();
    mocks.spawn.mockReturnValue(child);
    let settled = false;
    const pending = resolveShellExecutable("bash").then(result => { settled = true; return result; });
    expect(mocks.spawn).toHaveBeenCalledWith(firstPath, ["--noprofile", "--norc", "-lc", "printf firefly-bash-probe"], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.emit("data", Buffer.from("firefly-"));
    child.stdout.emit("data", Buffer.from("bash-probe"));
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    child.emit("close", 0);
    expect(await pending).toEqual({ kind: "bash", executable: firstPath });
    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("kills a timed-out probe and allows the next probe to finish after five seconds total", async () => {
    const first = new ProbeProcess();
    const second = new ProbeProcess();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let settled = false;
    const pending = resolveShellExecutable("bash").then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(first.kill).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(mocks.spawn.mock.calls[1][0]).toBe(secondPath);
    first.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(2500);
    expect(settled).toBe(false);
    second.stdout.emit("data", Buffer.from("firefly-bash-probe"));
    second.emit("close", 0);
    expect(await pending).toEqual({ kind: "bash", executable: secondPath });
    expect(second.kill).not.toHaveBeenCalled();
  });

  it("rejects spawn failures, wrong output and unsuccessful exits without selecting cmd", async () => {
    const first = new ProbeProcess();
    const second = new ProbeProcess();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const pending = resolveShellExecutable("bash");
    first.emit("error", Object.assign(new Error("fixture spawn failure"), { code: "ENOENT" }));
    await vi.advanceTimersByTimeAsync(0);
    second.stdout.emit("data", Buffer.from("not-the-probe"));
    second.emit("close", 1);
    expect(await pending).toBeNull();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(first.kill).not.toHaveBeenCalled();
    expect(second.kill).not.toHaveBeenCalled();
  });

  it("does not spawn for missing executables", async () => {
    mocks.existsSync.mockReturnValue(false);
    expect(await resolveShellExecutable("bash")).toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
