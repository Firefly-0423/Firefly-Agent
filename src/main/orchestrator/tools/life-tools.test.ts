import { beforeEach, afterEach, it, describe, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";

const fixture = vi.hoisted(() => ({ root: "", tools: new Map<string, ToolDefinition>() }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: {
  register: (value: ToolDefinition) => fixture.tools.set(value.id, value),
  getById: (id: string) => fixture.tools.get(id), getEnabledTools: () => [...fixture.tools.values()],
} }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "Asia/Shanghai" }));
import { clearExchangeRateCache, registerLifeTools } from "./life-tools";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";
import { executeToolDefinition } from "./registry/tool-executor";

registerLifeTools();
const invoke = (id: string, args: Record<string, unknown>, context?: ToolContext) => fixture.tools.get(id)!.execute(args, context);
const replace = async (file: string, args: Record<string, unknown>, context?: ToolContext) => JSON.parse(await invoke("str_replace", { file_path: file, ...args }, context));
const prepare = (text: string) => { const file = join(fixture.root, "journal.md"); writeFileSync(file, text); return file; };
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "life-contract-73-"));
  clearExchangeRateCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  const target = resolve(fixture.root);
  if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true, force: true });
});

describe("registered content replacement", () => {
  it("reports a single applied edit and the actual modified file", async () => {
    const file = prepare("# Journal\n\nOriginal observation.\n");
    const result = await replace(file, { old_string: "Original observation.", new_string: "Revised observation." });
    expect(result).toMatchObject({ success: true, appliedEdits: 1, whitespaceNormalized: false });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ file, kind: "modified" });
    expect(readFileSync(file, "utf8")).toEqual("# Journal\n\nRevised observation.\n");
  });
  it("reports invalid argument keys and missing files as structured failures", async () => {
    const file = prepare("Recorded observation");
    const invalid = await replace(file, {});
    expect(invalid).toMatchObject({ success: false, errorCode: "INVALID_INPUT" });
    expect(invalid.error).toContain("file_path");
    expect(await replace(join(fixture.root, "absent.md"), { old_string: "prior", new_string: "next" }))
      .toMatchObject({ success: false, errorCode: "FILE_NOT_FOUND" });
  });
  it("seeds a zero-byte file and reports positive insertion evidence", async () => {
    const file = prepare("");
    const result = await replace(file, { old_string: "", new_string: "# Observation\n\nNight sky." });
    expect(result).toMatchObject({ success: true, appliedEdits: 1 });
    expect(readFileSync(file, "utf8")).toBe("# Observation\n\nNight sky.");
    expect(result.changes[0].kind).toBe("modified");
    expect(result.changes[0].insertions).toBeGreaterThan(0);
  });
  it("refuses an empty search string on an existing document without changing its bytes", async () => {
    const file = prepare("Keep this observation\n");
    const result = await replace(file, { old_string: "", new_string: "Unwanted overwrite" });
    expect(result).toMatchObject({ success: false, errorCode: "INVALID_INPUT" });
    expect(result.error).toContain("文件为空时可传空 old_string");
    expect(readFileSync(file, "utf8")).toBe("Keep this observation\n");
  });
  it("applies a successful batch atomically and returns one change per edit", async () => {
    const file = prepare("north\ncentre\nsouth\n");
    const result = await replace(file, { edits: [{ old_string: "north", new_string: "NORTH" }, { old_string: "south", new_string: "SOUTH" }] });
    expect(result).toMatchObject({ success: true, appliedEdits: 2 });
    expect(result.changes).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe("NORTH\ncentre\nSOUTH\n");
  });
  it("rolls back a batch if a later edit cannot match", async () => {
    const original = "north\ncentre\n";
    const file = prepare(original);
    const result = await replace(file, { edits: [{ old_string: "north", new_string: "NORTH" }, { old_string: "absent", new_string: "inserted" }] });
    expect(result).toMatchObject({ success: false, errorCode: "OLD_STRING_NOT_FOUND", diagnostic: { editIndex: 1 } });
    expect(readFileSync(file, "utf8")).toEqual(original);
  });
  it("captures original review bytes only for a validated successful edit", async () => {
    const file = prepare("earlier\nlater\n");
    expect((await replace(file, { old_string: "earlier", new_string: "EARLIER" }, { runId: "review-73", userQuery: "" })).success).toBe(true);
    const before = join(fixture.root, "firefly-runs/reviews/review-73/before");
    const copies = readdirSync(before);
    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(before, copies[0]), "utf8")).toBe("earlier\nlater\n");
    await replace(file, { old_string: "absent", new_string: "inserted" }, { runId: "failed-review-91", userQuery: "" });
    expect(existsSync(join(fixture.root, "firefly-runs/reviews/failed-review-91"))).toBe(false);
  });
  it("requires only a file path at schema level and exposes both edit forms", () => {
    const schema = fixture.tools.get("str_replace")!.inputSchema;
    expect(schema.required).toEqual(["file_path"]);
    expect(schema.properties.old_string).toBeDefined();
    expect(schema.properties.edits).toBeDefined();
  });
  it("records byte-hash write facts only after a real validated replacement", async () => {
    const file = prepare("prior observation");
    const coordinator = getWorkspaceExecutionCoordinator(fixture.root);
    const scope = (agentId: string) => ({ workspaceId: coordinator.workspaceId, parentRunId: "parent-73", groupId: "replacement-group-73", agentId, childRunId: "child-" + agentId, toolCallId: "call-" + agentId });
    await coordinator.runLeaf(scope("invalid"), "exclusive", undefined, async permit => {
      const result = await replace(file, { old_string: "absent", new_string: "unused" }, { userQuery: "", execution: { coordinator, scope: scope("invalid"), permit } });
      expect(result.success).toBe(false);
    });
    expect(coordinator.getWriteEvidence()).toEqual([]);
    await coordinator.runLeaf(scope("valid"), "exclusive", undefined, async permit => {
      const result = await executeToolDefinition(fixture.tools.get("str_replace")!, { file_path: file, old_string: "prior", new_string: "updated" },
        { userQuery: "", execution: { coordinator, scope: scope("valid"), permit } });
      expect(result.writes?.[0]).toMatchObject({ path: file, state: "applied", after: { sha256: createHash("sha256").update("updated observation").digest("hex") } });
    });
    await coordinator.closeGroup("replacement-group-73");
  });
});

describe("exchange-rate cache contains rates rather than converted amounts", () => {
  it("recalculates a different amount using a cached currency pair", async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({ rates: { CAD: 1.25 } })));
    vi.stubGlobal("fetch", network);
    const first = await invoke("exchange_rate", { from: "EUR", to: "CAD", amount: 80 });
    expect(first).toContain("100.00");
    expect(first.startsWith("[缓存]")).toBe(false);
    const next = await invoke("exchange_rate", { from: "EUR", to: "CAD", amount: 40 });
    expect(next.startsWith("[缓存]")).toBe(true);
    expect(next).toContain("50.00");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("fetches separate rates for distinct currency pairs", async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({ rates: { CAD: 1.25, CHF: 0.95 } })));
    vi.stubGlobal("fetch", network);
    await invoke("exchange_rate", { from: "EUR", to: "CAD" });
    await invoke("exchange_rate", { from: "EUR", to: "CHF" });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("retries after an unsuccessful HTTP response", async () => {
    const network = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(new Response(JSON.stringify({ rates: { CAD: 1.25 } })));
    vi.stubGlobal("fetch", network);
    expect((await invoke("exchange_rate", { from: "EUR", to: "CAD" })).startsWith("[错误]")).toBe(true);
    const recovered = await invoke("exchange_rate", { from: "EUR", to: "CAD" });
    expect(recovered).toContain("1.25");
    expect(recovered.startsWith("[缓存]")).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
  });
});
