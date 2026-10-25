import { beforeEach, afterEach, it, describe, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";

const canonicalPaths = vi.hoisted(() => ({ from: "", to: "" }));
vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return {
    ...actual,
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      if (String(args[0]) === canonicalPaths.from) return canonicalPaths.to;
      return actual.realpathSync(...args);
    },
  };
});

const fixture = vi.hoisted(() => ({ root: "", tools: new Map<string, ToolDefinition>() }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: {
  register: (entry: ToolDefinition) => fixture.tools.set(entry.id, entry),
  getById: (id: string) => fixture.tools.get(id), getEnabledTools: () => [...fixture.tools.values()],
} }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("../../storage/external-content-paths", () => ({ findSkillPath: () => null }));
vi.mock("pdfkit", () => ({ default: class { constructor() { throw new Error("INJECTED_PDF_RENDER_FAILURE"); } } }));
import { registerDocumentTools } from "./document-tools";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";
registerDocumentTools();
const invoke = (id: string, args: Record<string, unknown>, context?: ToolContext) => fixture.tools.get(id)!.execute(args, context);
function beforeFiles(runId: string) {
  const path = join(fixture.root, "firefly-runs/reviews", runId, "before");
  return existsSync(path) ? readdirSync(path).map(name => join(path, name)) : [];
}
beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), "document-contract-73-")); });
afterEach(() => {
  canonicalPaths.from = ""; canonicalPaths.to = "";
  const target = resolve(fixture.root);
  if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true, force: true });
});
const formats = [
  ["write_excel", "observations.xlsx", { sheets: [{ name: "Measurements", headers: ["distance"], rows: [[73]] }] }],
  ["write_word", "observations.docx", { title: "Night observations", paragraphs: ["A clear view of the sky."] }],
] as const;

describe("document arguments and model guidance", () => {
  it.each(["write_excel", "write_word"])("does not recommend an unregistered choice tool in %s", id => {
    const tool = fixture.tools.get(id);
    expect(tool).toBeDefined();
    expect(tool!.description).not.toContain("ask_user_choice");
  });
  it.each([
    ["write_excel", { sheets: [{ name: "Measurements", headers: [], rows: [] }] }, ".xlsx"],
    ["write_word", { title: "Observations", paragraphs: ["Night sky"] }, ".docx"],
    ["write_pdf", { title: "Observations", paragraphs: ["Night sky"] }, ".pdf"],
  ] as const)("identifies the missing filename and required suffix for %s", async (id, args, suffix) => {
    const result = await invoke(id, args);
    expect(result).toContain("未提供 filename");
    expect(result).toContain(suffix);
  });
  it("reports an absent sheet list together with the received filename key", async () => {
    const result = await invoke("write_excel", { filename: "measurements.xlsx" });
    expect(result).toContain("sheets 不能为空");
    expect(result).toContain("filename");
  });
});

describe("document realpath containment", () => {
  it("writes to an internal canonical output path with controlled link resolution", async () => {
    const real = join(fixture.root, "real"); mkdirSync(real);
    canonicalPaths.from = join(fixture.root, "alias"); mkdirSync(canonicalPaths.from);
    canonicalPaths.to = real;
    expect(await invoke("write_word", { filename: "alias/nested/report.docx", paragraphs: ["test"] }, { resolvedWorkspaceRoot: fixture.root })).toContain("已生成");
    expect(statSync(join(real, "nested/report.docx")).size).toBeGreaterThan(0);
    expect(readdirSync(canonicalPaths.from)).toEqual([]);
  });

  it.each([
    ["write_excel", "xlsx", { sheets: [{ name: "Data", headers: [], rows: [] }] }],
    ["write_word", "docx", { paragraphs: ["test"] }],
    ["write_pdf", "pdf", { paragraphs: ["test"] }],
  ] as const)("%s rejects a controlled ancestor realpath escape for workspace and desktop", async (id, ext, args) => {
    const workspace = join(fixture.root, "workspace");
    for (const root of [workspace, fixture.root]) {
      mkdirSync(join(root, "exports"), { recursive: true });
      canonicalPaths.from = join(root, "exports");
      canonicalPaths.to = resolve(fixture.root, "../outside");
      const context = root === workspace ? { resolvedWorkspaceRoot: workspace } : undefined;
      for (const filename of [`exports/report.${ext}`, `exports/new/nested/report.${ext}`]) {
        expect(await invoke(id, { ...args, filename }, context)).toContain("[错误]");
      }
      expect(readdirSync(join(root, "exports"))).toEqual([]);
    }
  });

  it.for([
    ["write_excel", "xlsx", { sheets: [{ name: "Data", headers: [], rows: [] }] }],
    ["write_word", "docx", { title: "Test", paragraphs: ["test"] }],
    ["write_pdf", "pdf", { title: "Test", paragraphs: ["test"] }],
  ] as const)("%s refuses an existing junction escape for workspace and desktop outputs", async ([id, ext, args], testContext) => {
    const workspace = join(fixture.root, "workspace");
    // 目标必须在桌面根（fixture.root）之外，否则 junction 指向的仍是合法区域。
    const outside = mkdtempSync(join(tmpdir(), "doc-tools-outside-"));
    mkdirSync(workspace);
    writeFileSync(join(outside, `report.${ext}`), "original");
    try {
      try {
        symlinkSync(outside, join(workspace, "exports"), "junction");
        symlinkSync(outside, join(fixture.root, "exports"), "junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") testContext.skip("Host sandbox does not permit junction creation");
        throw error;
      }
      for (const context of [{ resolvedWorkspaceRoot: workspace }, undefined]) {
        for (const filename of [`exports/report.${ext}`, `exports/new/nested/report.${ext}`]) {
          const result = await invoke(id, { ...args, filename }, context);
          expect(result).toContain("[错误]");
        }
      }
      expect(readdirSync(outside)).toEqual([`report.${ext}`]);
      expect(readFileSync(join(outside, `report.${ext}`), "utf8")).toBe("original");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows nested output through a junction within the workspace", async (testContext) => {
    mkdirSync(join(fixture.root, "real"));
    try { symlinkSync(join(fixture.root, "real"), join(fixture.root, "alias"), "junction"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") testContext.skip("Host sandbox does not permit junction creation");
      throw error;
    }
    expect(await invoke("write_word", { filename: "alias/new/report.docx", paragraphs: ["test"] }, { resolvedWorkspaceRoot: fixture.root })).toContain("已生成");
    expect(statSync(join(fixture.root, "real/new/report.docx")).size).toBeGreaterThan(0);
  });
});

describe("review capture precedes document generation", () => {
  it.each(formats)("stores a binary baseline before overwriting with %s", async (id, filename, args) => {
    writeFileSync(join(fixture.root, filename), Buffer.from([80, 75, 3, 4, 0, 73, 91]));
    expect(await invoke(id, { ...args, filename }, { runId: "binary-review-73", userQuery: "" })).toContain("已生成");
    const files = beforeFiles("binary-review-73");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.binary$/);
  });
  it("keeps PDF baseline metadata and original bytes when rendering fails", async () => {
    const file = join(fixture.root, "observations.pdf");
    const original = Buffer.from([37, 80, 68, 70, 0, 73, 91]);
    writeFileSync(file, original);
    await expect(invoke("write_pdf", { filename: "observations.pdf", title: "Night observations", paragraphs: ["A clear sky"] },
      { runId: "pdf-review-73", userQuery: "" })).rejects.toThrow("INJECTED_PDF_RENDER_FAILURE");
    const files = beforeFiles("pdf-review-73");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.binary$/);
    expect(JSON.parse(readFileSync(files[0], "utf8"))).toEqual({ size: original.length, hash: createHash("sha256").update(original).digest("hex") });
    expect(readFileSync(file)).toEqual(original);
  });
});

describe("trusted document output ownership", () => {
  it.each(formats)("%s records the actual generated artifact hash", async (id, filename, args) => {
    const coordinator = getWorkspaceExecutionCoordinator(fixture.root);
    const scope = { workspaceId: coordinator.workspaceId, parentRunId: "parent-73", groupId: "document-group-73", agentId: "document-agent-73", childRunId: "document-child-73", toolCallId: id };
    await coordinator.runLeaf(scope, "exclusive", undefined, async permit => {
      await invoke(id, { ...args, filename }, { userQuery: "", resolvedWorkspaceRoot: fixture.root, execution: { coordinator, scope, permit } });
    });
    const file = join(fixture.root, filename);
    expect(coordinator.getWriteEvidence()[0]).toMatchObject({
      path: file, before: { version: "absent" }, state: "applied", after: { sha256: createHash("sha256").update(readFileSync(file)).digest("hex") },
    });
    await coordinator.closeGroup(scope.groupId);
  });
  it("does not claim paths for invalid filenames or pre-render failures", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(fixture.root);
    const scope = { workspaceId: coordinator.workspaceId, parentRunId: "parent-91", groupId: "invalid-group-91", agentId: "document-agent-91", childRunId: "document-child-91", toolCallId: "invalid-document-91" };
    await coordinator.runLeaf(scope, "exclusive", undefined, async permit => {
      const context = { userQuery: "", resolvedWorkspaceRoot: fixture.root, execution: { coordinator, scope, permit } };
      expect(await invoke("write_excel", { filename: "../outside.xlsx", sheets: [] }, context)).toContain("[错误]");
      await expect(invoke("write_pdf", { filename: "unrendered.pdf", title: "Unrendered report", paragraphs: [] }, context)).rejects.toThrow("INJECTED_PDF_RENDER_FAILURE");
    });
    expect(coordinator.getWriteEvidence()).toEqual([]);
    await coordinator.closeGroup(scope.groupId);
  });
});
