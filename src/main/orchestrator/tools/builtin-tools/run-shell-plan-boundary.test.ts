import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentFileAccessLevel } from "../../../permission/permission-policy";
import {
  approvePlan, enterPlanDiscussing, markPlanWritten, moveToReview, resetPlanSessionsForTest,
} from "../../plan-mode";

const mocks = vi.hoisted(() => ({
  level: "full" as AgentFileAccessLevel,
  spawn: vi.fn(), wrap: vi.fn(), resolve: vi.fn(), background: vi.fn(),
  canonicalFrom: "", canonicalTo: "",
}));
vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return { ...actual, realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
    if (String(args[0]) === mocks.canonicalFrom) return mocks.canonicalTo;
    return actual.realpathSync(...args);
  } };
});
vi.mock("../../../permission/permission", () => ({ getCurrentLevel: () => mocks.level }));
vi.mock("child_process", async (original) => {
  const actual = await original<typeof import("child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    mocks.spawn(args[0], args[1], args[2]);
    return actual.spawn(...args);
  } };
});
vi.mock("../../sandbox/sandbox-exec", () => ({ wrapWithSandbox: (...args: unknown[]) => mocks.wrap(...args) }));
vi.mock("../../shell-runtime", async (original) => {
  const actual = await original<typeof import("../../shell-runtime")>();
  return { ...actual, resolveShellExecutable: (...args: unknown[]) => mocks.resolve(...args) };
});
vi.mock("./shell-job-manager", () => ({ killTree: vi.fn(), startShellJob: (...args: unknown[]) => mocks.background(...args) }));
vi.mock("../../../logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { BuiltinTools: "test" } }));
import { runShellTool } from "./run-shell-tool";
import { dispatchToolCall } from "../../harness/tool-dispatcher";

describe.runIf(process.platform === "win32")("actual run_shell plan and workspace guards", () => {
  let owned: string;
  let rootA: string;
  let rootB: string;
  const id = "synthetic-plan-boundary";
  const resolved = { kind: "cmd", executable: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe" };
  beforeEach(() => {
    owned = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-shell-boundary-"));
    rootA = path.join(owned, "A"); rootB = path.join(owned, "B");
    fs.mkdirSync(rootA); fs.mkdirSync(rootB);
    fs.writeFileSync(path.join(rootB, "sentinel.txt"), "outside-original");
    resetPlanSessionsForTest();
    vi.clearAllMocks(); mocks.level = "full";
    mocks.resolve.mockResolvedValue(resolved);
    mocks.wrap.mockResolvedValue({ ok: false, reason: "disabled" });
    mocks.background.mockReturnValue({ jobId: "synthetic", logFile: "synthetic" });
  });
  afterEach(() => {
    mocks.canonicalFrom = ""; mocks.canonicalTo = "";
    expect(fs.readFileSync(path.join(rootB, "sentinel.txt"), "utf8")).toBe("outside-original");
    expect(fs.existsSync(path.join(rootB, "created"))).toBe(false);
    const prefix = path.resolve(os.tmpdir()) + path.sep;
    if (!path.resolve(owned).startsWith(prefix) || !path.basename(owned).startsWith("firefly-shell-boundary-")) throw new Error("unsafe fixture cleanup");
    fs.rmSync(owned, { recursive: true }); resetPlanSessionsForTest();
  });
  async function run(args: Record<string, unknown>, snapshot: AgentFileAccessLevel = mocks.level) {
    try {
      return JSON.parse(await runShellTool.execute({ shell: "cmd", ...args }, {
        userQuery: "synthetic", conversationId: id, resolvedWorkspaceRoot: rootA, fileAccessLevel: snapshot,
      })) as { errorCode?: string; exitCode?: number; stdout?: string };
    } catch (error) {
      return { errorCode: (error as { code?: string }).code };
    }
  }
  function noExecution() {
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.background).not.toHaveBeenCalled();
  }
  for (const background of [false, true]) {
    for (const level of ["scoped", "project-read-only"] as const) {
      it(`${level} refuses lexical outside cwd before any execution, background=${background}`, async () => {
        mocks.level = level;
        expect((await run({ command: "echo changed> created", cwd: rootB, run_in_background: background })).errorCode).toBe("E_SHELL_CWD_OUTSIDE_WORKSPACE");
        noExecution(); expect(mocks.wrap).not.toHaveBeenCalled();
      });
    }
    // full / allow_all 没有沙箱，cwd 不是授权根目录，显式的工作区外目录保持原行为。
    it(`full keeps an explicit cwd outside the workspace, background=${background}`, async () => {
      mocks.level = "full";
      const result = await run({ command: "echo FULL_OK", cwd: rootB, run_in_background: background });
      expect(result.errorCode).toBeUndefined();
      expect(mocks.wrap).not.toHaveBeenCalled();
      if (background) expect(mocks.background.mock.calls[0][0].spec.cwd).toBe(rootB);
      else expect(mocks.spawn.mock.calls[0][2].cwd).toBe(rootB);
    });
    it(`rejects a controlled ancestor realpath escape, background=${background}`, async () => {
      mocks.level = "scoped";
      fs.mkdirSync(path.join(rootA, "exports"));
      mocks.canonicalFrom = path.join(rootA, "exports"); mocks.canonicalTo = rootB;
      expect((await run({ command: "echo changed> created", cwd: "exports/new", run_in_background: background })).errorCode).toBe("E_SHELL_CWD_OUTSIDE_WORKSPACE");
      noExecution(); expect(mocks.wrap).not.toHaveBeenCalled();
    });
    it(`preserves an internal canonical cwd and trusted sandbox root, background=${background}`, async () => {
      mocks.level = "scoped";
      const real = path.join(rootA, "real"); fs.mkdirSync(real);
      const alias = path.join(rootA, "alias"); fs.mkdirSync(alias);
      mocks.canonicalFrom = alias; mocks.canonicalTo = real;
      mocks.wrap.mockImplementation(async (command: string) => ({ ok: true, argv: [resolved.executable, "/d", "/s", "/c", command], env: process.env }));
      const result = await run({ command: "echo INTERNAL_OK> internal.txt", cwd: alias, run_in_background: background });
      expect(result.errorCode).toBeUndefined();
      expect(mocks.wrap.mock.calls[0][1]).toBe(real);
      expect(mocks.wrap.mock.calls[0][4]).toBe(fs.realpathSync(rootA));
      if (background) expect(mocks.background.mock.calls[0][0].spec.cwd).toBe(real);
      else {
        expect(result.exitCode).toBe(0);
        expect(fs.readFileSync(path.join(real, "internal.txt"), "utf8").trim()).toBe("INTERNAL_OK");
      }
    });
    for (const phase of ["resolve", "wrap"] as const) {
      it(`rechecks canonical cwd after ${phase}, background=${background}`, async () => {
        mocks.level = "scoped";
        const cwd = path.join(rootA, "sub"); fs.mkdirSync(cwd);
        const redirect = () => { mocks.canonicalFrom = cwd; mocks.canonicalTo = rootB; };
        if (phase === "resolve") mocks.resolve.mockImplementation(async () => { redirect(); return resolved; });
        else mocks.wrap.mockImplementation(async () => { redirect(); return { ok: true, argv: [resolved.executable], env: process.env }; });
        expect((await run({ command: "echo changed> created", cwd, run_in_background: background })).errorCode).toBe("E_SHELL_CWD_OUTSIDE_WORKSPACE");
        noExecution();
      });
    }
    for (const level of ["scoped", "project-read-only"] as const) {
      it(`${level} refuses outside cwd and junction cwd before wrapping, background=${background}`, async (testContext) => {
        mocks.level = level;
        const outsideResult = await run({ command: "echo changed> created", cwd: rootB, run_in_background: background });
        expect(outsideResult.errorCode).toBe("E_SHELL_CWD_OUTSIDE_WORKSPACE");
        noExecution(); expect(mocks.wrap).not.toHaveBeenCalled();
        try { fs.symlinkSync(rootB, path.join(rootA, "exports"), "junction"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") testContext.skip("Host sandbox does not permit junction creation; lexical outside cwd checked");
          throw error;
        }
        for (const cwd of [rootB, path.join(rootA, "exports"), path.join(rootA, "exports/new")]) {
          const result = await run({ command: "echo changed> created", cwd, run_in_background: background });
          expect(result.errorCode).toBe("E_SHELL_CWD_OUTSIDE_WORKSPACE");
        }
        noExecution(); expect(mocks.wrap).not.toHaveBeenCalled();
      });
    }
  }
  for (const level of ["scoped", "project-read-only"] as const) {
    it(`${level} without a bound workspace fails closed instead of deriving the sandbox root from cwd`, async () => {
      mocks.level = level;
      const raw = await runShellTool.execute({ shell: "cmd", command: "echo changed> created", cwd: rootB }, {
        userQuery: "synthetic", conversationId: id, fileAccessLevel: level,
      });
      expect((JSON.parse(raw) as { errorCode?: string }).errorCode).toBe("E_WORKSPACE_REQUIRED");
      noExecution(); expect(mocks.wrap).not.toHaveBeenCalled();
    });
  }
  it("defaults cwd to the bound workspace and preserves a legal relative subtree", async () => {
    mocks.level = "scoped";
    fs.mkdirSync(path.join(rootA, "sub"));
    mocks.wrap.mockImplementation(async (command: string) => ({ ok: true, argv: [resolved.executable, "/d", "/s", "/c", command], env: process.env }));
    expect((await run({ command: "echo ROOT_OK> root.txt" })).exitCode).toBe(0);
    expect((await run({ command: "echo SUB_OK> sub.txt", cwd: "sub" })).exitCode).toBe(0);
    expect(mocks.wrap.mock.calls.map((call) => call[4])).toEqual([fs.realpathSync(rootA), fs.realpathSync(rootA)]);
    expect(mocks.spawn.mock.calls.map((call) => call[2].cwd)).toEqual([fs.realpathSync(rootA), fs.realpathSync(path.join(rootA, "sub"))]);
    expect(fs.readFileSync(path.join(rootA, "root.txt"), "utf8").trim()).toBe("ROOT_OK");
    expect(fs.readFileSync(path.join(rootA, "sub/sub.txt"), "utf8").trim()).toBe("SUB_OK");
  });
  for (const level of ["full", "scoped"] as const) {
    for (const background of [false, true]) {
      it(`${level} PLAN_DISCUSSING blocks writes before interpreter resolution, background=${background}`, async () => {
        mocks.level = level; enterPlanDiscussing(id, rootA);
        const result = await run({ command: "echo changed> marker.txt", cwd: rootA, run_in_background: background });
        noExecution(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.wrap).not.toHaveBeenCalled();
        expect(result.errorCode).toBe("E_PLAN_READ_ONLY"); expect(fs.existsSync(path.join(rootA, "marker.txt"))).toBe(false);
      });
    }
  }
  it("PLAN_REVIEW blocks a nominal read command without trusting shell classification", async () => {
    enterPlanDiscussing(id, rootA); markPlanWritten(id); moveToReview(id);
    const result = await run({ command: "git status", cwd: rootA });
    noExecution(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(result.errorCode).toBe("E_PLAN_READ_ONLY");
  });
  for (const background of [false, true]) {
    it(`rechecks live plan after awaited interpreter resolution, background=${background}`, async () => {
      mocks.resolve.mockImplementation(async () => {
        enterPlanDiscussing(id, rootA); markPlanWritten(id); moveToReview(id); return resolved;
      });
      const result = await run({ command: "echo changed> marker.txt", cwd: rootA, run_in_background: background });
      noExecution(); expect(result.errorCode).toBe("E_PLAN_READ_ONLY");
    });
  }
  it("EXECUTING full retains a real legal write in A", async () => {
    enterPlanDiscussing(id, rootA); markPlanWritten(id); moveToReview(id); expect(approvePlan(id)).toBe(true);
    const result = await run({ command: "echo SYNTHETIC_OK> marker.txt", cwd: rootA });
    expect(result.exitCode).toBe(0); expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(rootA, "marker.txt"), "utf8").trim()).toBe("SYNTHETIC_OK");
  });
  it("a full current setting cannot widen a read-only session when sandbox is disabled", async () => {
    const result = await run({ command: "echo changed> marker.txt", cwd: rootA }, "read-only");
    noExecution(); expect(result.exitCode).toBe(-1); expect(fs.existsSync(path.join(rootA, "marker.txt"))).toBe(false);
  });
  it("heuristic read classification cannot bypass a disabled sandbox for read-only sessions", async () => {
    mocks.level = "read-only";
    const result = await run({ command: "git status", cwd: rootA });
    noExecution(); expect(result.exitCode).toBe(-1);
  });
  for (const background of [false, true]) {
    it(`rechecks plan after sandbox wrapping, background=${background}`, async () => {
      mocks.level = "read-only";
      mocks.wrap.mockImplementation(async () => {
        enterPlanDiscussing(id, rootA); markPlanWritten(id); moveToReview(id);
        return { ok: true, argv: [resolved.executable, "/d", "/s", "/c", "echo changed> marker.txt"], env: process.env };
      });
      const result = await run({ command: "echo changed> marker.txt", cwd: rootA, run_in_background: background });
      noExecution(); expect(result.errorCode).toBe("E_PLAN_READ_ONLY");
    });
  }
  it("fails closed when permissions tighten during interpreter resolution", async () => {
    mocks.resolve.mockImplementation(async () => { mocks.level = "read-only"; return resolved; });
    const result = await run({ command: "echo changed> marker.txt", cwd: rootA }, "full");
    noExecution(); expect(result.errorCode).toBe("E_PERMISSION_CHANGED");
  });
  it("requires an exact invocation authorization for per-action shell calls", async () => {
    mocks.level = "per-action";
    const result = await run({ command: "echo changed> marker.txt", cwd: rootA });
    noExecution(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(result.errorCode).toBe("E_PERMISSION_APPROVAL_REQUIRED");
  });
  it("preserves one approved per-action invocation through the actual dispatcher", async () => {
    mocks.level = "per-action";
    const permission = vi.fn(async () => true);
    mocks.wrap.mockImplementation(async (command: string) => ({ ok: true,
      argv: [resolved.executable, "/d", "/s", "/c", command], env: process.env,
    }));
    const outcome = await dispatchToolCall({ id: "approved-shell", name: "run_shell", arguments: JSON.stringify({ command: "echo APPROVED_OK> marker.txt", shell: "cmd", cwd: rootA }) }, {
      state: { todoItems: [], uncertainEffects: [] }, tools: [runShellTool], checkPermission: permission,
      toolContext: { userQuery: "synthetic", conversationId: id, resolvedWorkspaceRoot: rootA, fileAccessLevel: "per-action" },
    });
    expect(outcome.outcome).toBe("success"); expect(permission).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.wrap.mock.calls[0][3]).toBe("per-action");
    expect(fs.readFileSync(path.join(rootA, "marker.txt"), "utf8").trim()).toBe("APPROVED_OK");
  });
  it("preserves an actually approved per-action call when the sandbox is explicitly disabled", async () => {
    mocks.level = "per-action";
    const permission = vi.fn(async () => true);
    const outcome = await dispatchToolCall({ id: "approved-disabled-shell", name: "run_shell", arguments: JSON.stringify({ command: "echo APPROVED_DISABLED_OK> marker.txt", shell: "cmd", cwd: rootA }) }, {
      state: { todoItems: [], uncertainEffects: [] }, tools: [runShellTool], checkPermission: permission,
      toolContext: { userQuery: "synthetic", conversationId: id, resolvedWorkspaceRoot: rootA, fileAccessLevel: "per-action" },
    });
    expect(outcome.outcome).toBe("success"); expect(permission).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(rootA, "marker.txt"), "utf8").trim()).toBe("APPROVED_DISABLED_OK");
  });
  for (const phase of ["permission", "resolve", "wrap"] as const) {
    it(`does not reuse an unapproved permission decision when a new approval is required during ${phase}`, async () => {
      mocks.level = "full";
      const permission = vi.fn(async () => { if (phase === "permission") mocks.level = "per-action"; return true; });
      mocks.resolve.mockImplementation(async () => { if (phase === "resolve") mocks.level = "per-action"; return resolved; });
      mocks.wrap.mockImplementation(async (command: string) => {
        if (phase === "wrap") mocks.level = "per-action";
        return { ok: true, argv: [resolved.executable, "/d", "/s", "/c", command], env: process.env };
      });
      const outcome = await dispatchToolCall({ id: `approval-race-${phase}`, name: "run_shell", arguments: JSON.stringify({ command: "echo changed> marker.txt", shell: "cmd", cwd: rootA }) }, {
        state: { todoItems: [], uncertainEffects: [] }, tools: [runShellTool], checkPermission: permission,
        toolContext: { userQuery: "synthetic", conversationId: id, resolvedWorkspaceRoot: rootA, fileAccessLevel: "scoped" },
      });
      noExecution(); expect(permission).toHaveBeenCalledTimes(1); expect(outcome.outcome).toBe("failure");
      expect(outcome.rawResult).toMatchObject({ errorCode: phase === "permission" ? "E_PERMISSION_CHANGED" : "E_PERMISSION_APPROVAL_REQUIRED", effectState: "not_applied" });
      expect(fs.existsSync(path.join(rootA, "marker.txt"))).toBe(false);
    });
  }
});
