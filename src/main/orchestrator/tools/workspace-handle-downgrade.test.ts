import * as fs from "fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition } from "./registry/tool-registry";
const { state, registry } = vi.hoisted(() => ({ state: { root: "", data: "", level: "full", deniedCalls: [] as string[] }, registry: new Map<string, ToolDefinition>() }));
vi.mock("fs", async original => {
  const actual = await original<typeof import("fs")>(); const wrapped = { ...actual } as Record<string, unknown>;
  for (const name of ["openSync", "readFileSync", "statSync"] as const) wrapped[name] = (...args: unknown[]) => {
    if (state.level === "project-read-only" && typeof args[0] === "string" && args[0].startsWith(state.root + path.sep)) {
      state.deniedCalls.push(name); throw Error("path I/O after downgrade");
    }
    return (actual[name] as (...a: unknown[]) => unknown)(...args);
  };
  return wrapped;
});
vi.mock("../../permission", () => ({ getCurrentLevel: () => state.level }));
vi.mock("electron", () => ({ app: { getPath: () => state.data, isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: { register: (t: ToolDefinition) => registry.set(t.id, t) } }));
// This test isolates permission callbacks on plain fixture paths. Native name/ID
// resolution and role-ownership behavior are exercised in their own tests.
vi.mock("../harness/write-ownership", () => ({ canonicalWriteIdentity: (file: string) => path.resolve(file).toLowerCase(), observedWriteIdentity: (file: string) => path.resolve(file).toLowerCase() }));
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "UTC" }));
vi.mock("../vision-captioner", () => ({ captionImage: vi.fn() }));
import "./fs-tools";
import { registerLifeTools } from "./life-tools";
import { getRunReviewTracker } from "../review/run-review-tracker";
registerLifeTools();
let fixture: string;
beforeEach(() => {
  state.level = "full"; state.deniedCalls = [];
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-downgrade-"));
  state.root = path.join(fixture, "workspace"); state.data = path.join(fixture, "userdata");
  fs.mkdirSync(state.root); fs.mkdirSync(state.data); fs.writeFileSync(path.join(state.root, "file.txt"), "original");
});
afterEach(() => { state.level = "full"; fs.rmSync(fixture, { recursive: true, force: true }); vi.restoreAllMocks(); });
function context(onFact: (fact: { state: string }) => void): ToolContext {
  const scope = { workspaceId: "w", parentRunId: "p", groupId: "g", agentId: "a", childRunId: "c", toolCallId: "t" };
  const coordinator = { assertPermit: () => scope, writeOwnership: { claim: () => {} }, recordWriteEvidence: (_p: unknown, fact: { state: string }) => onFact(fact) };
  return { userQuery: "downgrade", runId: "run", fileAccessLevel: "full", resolvedWorkspaceRoot: state.root,
    execution: { coordinator, scope, permit: {} } as unknown as ToolContext["execution"] };
}
it("a subscriber downgrade stops str_replace before its unrestricted review capture", async () => {
  const tracker = getRunReviewTracker(state.data), capture = vi.spyOn(tracker, "captureBefore");
  const ctx = context(fact => { if (fact.state === "not_applied") state.level = "project-read-only"; });
  await expect(registry.get("str_replace")!.execute({ file_path: path.join(state.root, "file.txt"), old_string: "original", new_string: "updated" }, ctx))
    .rejects.toMatchObject({ category: "permission_denied", effectState: "not_applied" });
  expect(capture).not.toHaveBeenCalled(); expect(state.deniedCalls).toEqual([]);
});
it.each(["write_file", "str_replace"])("%s never stats by path after an applied-evidence subscriber downgrades it", async id => {
  const facts: Array<{ state: string }> = [];
  const ctx = context(fact => { facts.push(fact); if (fact.state === "applied") state.level = "project-read-only"; });
  const file = path.join(state.root, "file.txt"), args = id === "write_file" ? { path: file, content: "updated" } : { file_path: file, old_string: "original", new_string: "updated" };
  await expect(registry.get(id)!.execute(args, ctx)).rejects.toMatchObject({ category: "permission_denied", effectState: "unknown" });
  expect(state.deniedCalls).toEqual([]); expect(facts.at(-1)?.state).toBe("applied");
  const actual = await vi.importActual<typeof import("fs")>("fs"); expect(actual.readFileSync(file, "utf8")).toBe("updated");
});
