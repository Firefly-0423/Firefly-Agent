import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import { join, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";
import { parsePatch, applyPatchHunks } from "./apply-patch-tools";
import type { ToolContext } from "./registry/tool-context";

const fault = vi.hoisted(() => ({ target: "", redirectFrom: "", redirectTo: "", collideOnCopy: false }));
vi.mock("fs", async original => {
  const native = await original<typeof import("fs")>();
  return { ...native,
    realpathSync: (...args: Parameters<typeof native.realpathSync>) => {
      if (String(args[0]) === fault.redirectFrom) return fault.redirectTo;
      return native.realpathSync(...args);
    },
    copyFileSync: (...args: Parameters<typeof native.copyFileSync>) => {
      if (fault.collideOnCopy) {
        fault.collideOnCopy = false;
        native.writeFileSync(args[1], "concurrent destination");
      }
      return native.copyFileSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof native.writeFileSync>) => {
      if (String(args[0]) === fault.target) {
        fault.target = "";
        native.writeFileSync(args[0], "incomplete observation");
        throw new Error("Injected partial artifact write");
      }
      return native.writeFileSync(...args);
    } };
});
let root: string;
const envelope = (lines: string[], eol = "\n") => ["*** Begin Patch", ...lines, "*** End Patch"].join(eol);
const put = (name: string, text: string) => { const file = join(root, name); fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const contents = (name: string) => fs.readFileSync(join(root, name), "utf8");
const apply = (lines: string[], context?: ToolContext, eol?: string) => {
  const parsed = parsePatch(envelope(lines, eol));
  expect(parsed.errors).toEqual([]);
  return applyPatchHunks(parsed.hunks, root, context);
};
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), "patch-contract-73-")); });
afterEach(() => {
  fault.target = "";
  fault.redirectFrom = ""; fault.redirectTo = ""; fault.collideOnCopy = false;
  const target = resolve(root);
  if (target.startsWith(resolve(tmpdir()) + sep)) fs.rmSync(target, { recursive: true, force: true });
});

describe("patch filesystem containment and move collisions", () => {
  it.each([
    "*** Add File: exports/nested/new.txt\n+new",
    "*** Delete File: exports/old.txt",
    "*** Update File: exports/old.txt\n@@\n-original\n+changed",
    "*** Update File: source.txt\n*** Move to: exports/new.txt\n@@\n-original\n+changed",
  ])("rejects a controlled ancestor realpath escape before any mutation: %s", (operation) => {
    put("exports/old.txt", "original");
    put("source.txt", "original");
    fault.redirectFrom = join(root, "exports");
    fault.redirectTo = resolve(root, "../outside");
    const result = applyPatchHunks(parsePatch(`*** Begin Patch\n*** Add File: safe.txt\n+safe\n${operation}\n*** End Patch`).hunks, root);
    expect(result.success).toBe(false);
    expect(result.applied).toEqual([]);
    expect(fs.existsSync(join(root, "safe.txt"))).toBe(false);
    expect(contents("source.txt")).toBe("original");
    expect(contents("exports/old.txt")).toBe("original");
  });

  it("refuses a Move to collision at exclusive creation without changing the source", () => {
    put("source.txt", "original\r\n");
    fault.collideOnCopy = true;
    const patch = "*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-original\n+changed\n*** End Patch";
    expect(applyPatchHunks(parsePatch(patch).hunks, root).success).toBe(false);
    expect(contents("source.txt")).toBe("original\r\n");
    expect(contents("destination.txt")).toBe("concurrent destination");
  });

  it("moves edited content into a new nested destination while preserving CRLF", () => {
    put("source.txt", "original\r\n");
    const patch = "*** Begin Patch\n*** Update File: source.txt\n*** Move to: nested/destination.txt\n@@\n-original\n+changed\n*** End Patch";
    expect(applyPatchHunks(parsePatch(patch).hunks, root).success).toBe(true);
    expect(fs.existsSync(join(root, "source.txt"))).toBe(false);
    expect(contents("nested/destination.txt")).toBe("changed\r\n");
  });

  function fixture(skip: (reason: string) => never) {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "old.txt"), "original");
    try { fs.symlinkSync(outside, join(workspace, "exports"), "junction"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") skip("Host sandbox does not permit junction creation");
      throw error;
    }
    return { workspace, outside };
  }

  it.for([
    "*** Add File: exports/nested/new.txt\n+new",
    "*** Delete File: exports/old.txt",
    "*** Update File: exports/old.txt\n@@\n-original\n+changed",
    "*** Update File: source.txt\n*** Move to: exports/new.txt\n@@\n-original\n+changed",
  ])("rejects junction escapes before any hunk is applied: %s", (operation, context) => {
    const { workspace, outside } = fixture(context.skip);
    fs.writeFileSync(join(workspace, "source.txt"), "original");
    const result = applyPatchHunks(parsePatch(`*** Begin Patch\n*** Add File: safe.txt\n+safe\n${operation}\n*** End Patch`).hunks, workspace);
    expect(result.success).toBe(false);
    expect(result.applied).toEqual([]);
    expect(fs.existsSync(join(workspace, "safe.txt"))).toBe(false);
    expect(fs.readFileSync(join(workspace, "source.txt"), "utf8")).toBe("original");
    expect(fs.readdirSync(outside)).toEqual(["old.txt"]);
    expect(fs.readFileSync(join(outside, "old.txt"), "utf8")).toBe("original");
  });

  it("refuses Move to an existing destination before changing source or other hunks", () => {
    put("source.txt", "original"); put("important.txt", "keep me");
    const patch = "*** Begin Patch\n*** Add File: safe.txt\n+safe\n*** Update File: source.txt\n*** Move to: important.txt\n@@\n-original\n+changed\n*** End Patch";
    const result = applyPatchHunks(parsePatch(patch).hunks, root);
    expect(result.success).toBe(false);
    expect(result.applied).toEqual([]);
    expect(contents("source.txt")).toBe("original");
    expect(contents("important.txt")).toBe("keep me");
    expect(fs.existsSync(join(root, "safe.txt"))).toBe(false);
  });

  it("does not overwrite a destination created by an earlier hunk", () => {
    put("source.txt", "original");
    const patch = "*** Begin Patch\n*** Add File: destination.txt\n+keep me\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-original\n+changed\n*** End Patch";
    const result = applyPatchHunks(parsePatch(patch).hunks, root);
    expect(result.success).toBe(false);
    expect(contents("source.txt")).toBe("original");
    if (fs.existsSync(join(root, "destination.txt"))) expect(contents("destination.txt")).toBe("keep me");
  });

  it("permits junctions whose target stays inside the workspace", (context) => {
    const target = join(root, "real"); fs.mkdirSync(target);
    try { fs.symlinkSync(target, join(root, "alias"), "junction"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("Host sandbox does not permit junction creation");
      throw error;
    }
    const patch = "*** Begin Patch\n*** Add File: alias/nested/new.txt\n+new\n*** End Patch";
    expect(applyPatchHunks(parsePatch(patch).hunks, root).success).toBe(true);
    expect(contents("real/nested/new.txt")).toBe("new");
  });
});

describe("public patch parser output", () => {
  it("preserves the ordered context, removal and addition rows of an update", () => {
    expect(parsePatch(envelope(["*** Update File: src/measure.ts", "@@", " let distance = 73;", "-let angle = 91;", "+let angle = 92;"])))
      .toEqual({ errors: [], hunks: [{ type: "update", path: "src/measure.ts", chunks: [{ lines: [
        { type: "context", content: "let distance = 73;" }, { type: "removal", content: "let angle = 91;" }, { type: "addition", content: "let angle = 92;" },
      ] }] }] });
  });
  it("parses complete added content and a delete operation", () => {
    const parsed = parsePatch(envelope(["*** Add File: src/measurement.ts", "+export const north = 73;", "+export const south = 91;", "*** Delete File: src/retired.ts"]));
    expect(parsed).toEqual({ errors: [], hunks: [
      { type: "add", path: "src/measurement.ts", content: "export const north = 73;\nexport const south = 91;" },
      { type: "delete", path: "src/retired.ts" },
    ] });
  });
  it("preserves an update destination and multiple chunk boundaries", () => {
    const parsed = parsePatch(envelope(["*** Update File: src/previous.ts", "*** Move to: src/current.ts", "@@", " let north = 73;", "-let east = 91;", "+let east = 92;", "@@", " let south = 74;", "-let west = 93;", "+let west = 94;"]));
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.hunks).toHaveLength(1);
    const update = parsed.hunks[0];
    expect(update.type).toBe("update");
    if (update.type !== "update") throw new Error("Expected an update hunk");
    expect(update.movePath).toBe("src/current.ts");
    expect(update.chunks).toHaveLength(2);
  });
  it("retains the order of update, add and delete operations", () => {
    const parsed = parsePatch(envelope(["*** Update File: first.txt", "@@", "-prior", "+next", "*** Add File: second.txt", "+created", "*** Delete File: third.txt"]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.hunks.map(hunk => hunk.type)).toEqual(["update", "add", "delete"]);
  });
  it("reports a missing begin marker with no executable hunks", () => {
    const result = parsePatch("Unstructured edit request");
    expect(result.hunks).toHaveLength(0);
    expect(result.errors).toEqual(["patch 必须以 *** Begin Patch 开头"]);
  });
});

describe("patch effects on actual workspace files", () => {
  it.each(["\n", "\r\n"])("updates context-matched text while preserving %j endings", eol => {
    put("src/measure.ts", ["let north = 73;", "let centre = 91;", "let south = 74;", ""].join(eol));
    const result = apply(["*** Update File: src/measure.ts", "@@", " let north = 73;", "-let centre = 91;", "+let centre = 92;", " let south = 74;"]);
    expect(result.success).toBe(true);
    expect(contents("src/measure.ts")).toBe(["let north = 73;", "let centre = 92;", "let south = 74;", ""].join(eol));
  });
  it("accepts a CRLF-encoded patch without inserting stray carriage returns", () => {
    put("measure.txt", "north\r\ncentre\r\n");
    expect(apply(["*** Update File: measure.txt", "@@", " north", "-centre", "+middle"], undefined, "\r\n").success).toBe(true);
    expect(contents("measure.txt")).toBe("north\r\nmiddle\r\n");
  });
  it("normalizes a mixed-ending document to its existing CRLF style", () => {
    put("mixed.txt", "north\r\ncentre\r\nsouth\n");
    expect(apply(["*** Update File: mixed.txt", "@@", " centre", "-south", "+SOUTH"]).success).toBe(true);
    expect(contents("mixed.txt")).toBe("north\r\ncentre\r\nSOUTH\r\n");
  });
  it("creates a nested file and deletes an existing file", () => {
    put("retired.txt", "retired observation");
    expect(apply(["*** Add File: notes/current.txt", "+current observation", "*** Delete File: retired.txt"]).success).toBe(true);
    expect(contents("notes/current.txt")).toBe("current observation");
    expect(fs.existsSync(join(root, "retired.txt"))).toBe(false);
  });
  it("moves a context-matched file to its new path", () => {
    put("notes/previous.txt", "observation\n");
    expect(apply(["*** Update File: notes/previous.txt", "*** Move to: notes/current.txt", "@@", " observation"]).success).toBe(true);
    expect(fs.existsSync(join(root, "notes/previous.txt"))).toBe(false);
    expect(fs.existsSync(join(root, "notes/current.txt"))).toBe(true);
  });
  it("inserts a row without removals and applies later chunks in sequence", () => {
    put("directions.txt", "north\neast\nsouth\nwest\n");
    const result = apply(["*** Update File: directions.txt", "@@", " north", "+north-east", " east", "@@", " south", "-west", "+WEST"]);
    expect(result.success).toBe(true);
    expect(contents("directions.txt")).toBe("north\nnorth-east\neast\nsouth\nWEST\n");
  });
  it("replaces two separated chunks within one existing file", () => {
    put("measurements.txt", "north=73\neast=91\nsouth=74\nwest=93\n");
    const result = apply(["*** Update File: measurements.txt", "@@", " north=73", "-east=91", "+east=92", "@@", " south=74", "-west=93", "+west=94"]);
    expect(result.success).toBe(true);
    expect(contents("measurements.txt")).toBe("north=73\neast=92\nsouth=74\nwest=94\n");
  });
  it("refuses mismatched context without changing the file", () => {
    put("measure.txt", "north\ncentre\n");
    const result = apply(["*** Update File: measure.txt", "@@", " north", "-absent", "+middle"]);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(contents("measure.txt")).toBe("north\ncentre\n");
  });
  it("prevalidates every file before applying an otherwise valid earlier update", () => {
    put("measure.txt", "north\ncentre\n");
    expect(apply(["*** Update File: measure.txt", "@@", "-north", "+NORTH", "*** Update File: absent.txt", "@@", "-prior", "+next"]).success).toBe(false);
    expect(contents("measure.txt")).toBe("north\ncentre\n");
  });
  it("rejects paths outside the workspace", () => {
    const result = apply(["*** Add File: ../../outside-contract-73.txt", "+must not escape"]);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("路径逃逸");
  });
});

describe("trusted patch claims and actual write evidence", () => {
  async function coordinated(action: (coordinator: ReturnType<typeof getWorkspaceExecutionCoordinator>, context: ToolContext) => void) {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const scope = { workspaceId: coordinator.workspaceId, parentRunId: "patch-parent-73", groupId: "patch-group-73", agentId: "patch-agent-73", childRunId: "patch-child-73", toolCallId: "patch-call-73" };
    await coordinator.runLeaf(scope, "exclusive", undefined, async permit => { action(coordinator, { userQuery: "", execution: { coordinator, scope, permit } }); });
    await coordinator.closeGroup(scope.groupId);
    return coordinator;
  }
  it("claims nothing when a later delete fails preflight", async () => {
    const coordinator = await coordinated((_coordinator, context) => {
      expect(apply(["*** Add File: proposed.txt", "+new observation", "*** Delete File: absent.txt"], context).success).toBe(false);
    });
    expect(coordinator.getWriteEvidence()).toEqual([]);
    expect(fs.existsSync(join(root, "proposed.txt"))).toBe(false);
  });
  it("rejects a later chunk whose required context was removed by an earlier chunk", async () => {
    put("directions.txt", "north\neast\nsouth\nwest\n");
    const coordinator = await coordinated((_coordinator, context) => {
      const result = apply(["*** Add File: proposed.txt", "+created observation", "*** Update File: directions.txt", "@@", "-east", "-south", "@@", "-south", "+SOUTH"], context);
      expect(result.success).toBe(false);
      expect(result.applied).toEqual([]);
    });
    expect(coordinator.getWriteEvidence()).toEqual([]);
    expect(fs.existsSync(join(root, "proposed.txt"))).toBe(false);
    expect(contents("directions.txt")).toBe("north\neast\nsouth\nwest\n");
  });
  it("reports completed operations and hashes the real partially written artifact", async () => {
    fault.target = join(root, "incomplete.txt");
    const coordinator = await coordinated((_coordinator, context) => {
      const result = apply(["*** Add File: complete.txt", "+complete observation", "*** Add File: incomplete.txt", "+intended observation"], context);
      expect(result.success).toBe(false);
      expect(result.applied).toEqual(["新增文件: complete.txt"]);
    });
    const writes = coordinator.getWriteEvidence();
    expect(writes.map(record => record.state)).toEqual(["applied", "partially_applied"]);
    expect(contents("complete.txt")).toBe("complete observation");
    expect(contents("incomplete.txt")).toBe("incomplete observation");
    expect(writes[1].before).toEqual({ version: "absent" });
    expect(writes[1].after?.sha256).toBeDefined();
    expect(writes[1].after?.sha256).toBe(createHash("sha256").update("incomplete observation").digest("hex"));
  });
  it.runIf(process.platform !== "win32")("retains distinct operation paths when deleting an alias before updating its target", async () => {
    const real = put("target.txt", "prior observation\n");
    const alias = join(root, "link.txt");
    fs.symlinkSync(real, alias);
    const coordinator = await coordinated((_coordinator, context) => {
      expect(apply(["*** Delete File: link.txt", "*** Update File: target.txt", "@@", "-prior observation", "+current observation"], context).success).toBe(true);
    });
    expect(fs.existsSync(alias)).toBe(false);
    expect(fs.readFileSync(real, "utf8")).toBe("current observation\n");
    const writes = coordinator.getWriteEvidence();
    expect(writes).toHaveLength(2);
    expect(writes.find(record => record.path === alias)).toMatchObject({ state: "applied", after: { version: "absent" } });
    expect(writes.find(record => record.path === real)).toMatchObject({ state: "applied", after: { version: "present", sha256: createHash("sha256").update("current observation\n").digest("hex") } });
    expect(writes.every(record => record.canonicalPath === real)).toBe(true);
  });
});
