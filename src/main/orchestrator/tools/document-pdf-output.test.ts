import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let PDF: typeof import("pdfkit").default;
const tools = new Map<string, any>();
const documents: any[] = [];
const streams: fs.WriteStream[] = [];
// Node's ESM named fs exports are snapshots; forward injected faults through
// the real fs object so the tool's namespace import observes the same boundary.
vi.mock("fs", async importOriginal => {
  const real = await importOriginal<typeof import("fs")>();
  return { ...real, default: real.default,
    existsSync: (...args: any[]) => (real.default.existsSync as any)(...args),
    readFileSync: (...args: any[]) => (real.default.readFileSync as any)(...args),
    createWriteStream: (...args: any[]) => (real.default.createWriteStream as any)(...args),
    renameSync: (...args: any[]) => (real.default.renameSync as any)(...args),
  };
});
vi.mock("electron", () => ({ app: { getPath: () => root } }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: { register: (tool: any) => tools.set(tool.id, tool) } }));
vi.mock("../../external-content-paths", () => ({ findSkillPath: () => null }));
import { createHash } from "node:crypto";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";
import type { ToolContext } from "./registry/tool-context";
import { registerDocumentTools } from "./document-tools";
registerDocumentTools();

const oldBytes = Buffer.from("%PDF-original\0synthetic");
const windowsFonts = /^C:\\Windows\\Fonts\\/;
const msyh = "C:\\Windows\\Fonts\\msyh.ttc";
const execute = (execution?: ToolContext["execution"]) => tools.get("write_pdf").execute(
  { filename: "report.pdf", title: "标题", paragraphs: ["段落一"] },
  { userQuery: "", runId: "pdf-protection", execution },
);
const target = () => path.join(root, "report.pdf");
const temporaryFiles = () => fs.readdirSync(root).filter(name => name.startsWith(".firefly-pdf-"));
function noSystemFonts() {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(file => windowsFonts.test(String(file)) ? false : exists(file));
}

beforeEach(async () => {
  const parent = path.resolve("output/pdf-output-tests");
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "case-"));
  fs.writeFileSync(target(), oldBytes);
  PDF = (await import("pdfkit")).default;
  const font = PDF.prototype.font;
  vi.spyOn(PDF.prototype, "font").mockImplementation(function (this: any, ...args: any[]) {
    if (!documents.includes(this)) documents.push(this);
    return font.apply(this, args as any);
  });
  const create = fs.createWriteStream;
  vi.spyOn(fs, "createWriteStream").mockImplementation((...args) => {
    const stream = create(...args); stream.on("error", () => {}); streams.push(stream); return stream;
  });
});
afterEach(async () => {
  // Also close resources from the old implementation during RED verification.
  for (const doc of documents.splice(0)) doc.destroy();
  for (const stream of streams) stream.destroy();
  await Promise.all(streams.splice(0).map(stream => stream.closed ? Promise.resolve() : new Promise(resolve => stream.once("close", resolve))));
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("real PDF output protection", () => {
  it("replaces the target only after a complete PDF and closed streams", async () => {
    noSystemFonts();
    await expect(execute()).resolves.toContain("已生成");
    const pdf = fs.readFileSync(target());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(oldBytes.length);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it.runIf(process.platform === "win32")("embeds the real Windows MicrosoftYaHei TTC face", async () => {
    expect(fs.existsSync(msyh)).toBe(true);
    const start = performance.now();
    await expect(execute()).resolves.toContain("已生成");
    console.info("[PdfEvidence]", JSON.stringify({ stage: "real-ttc-success", durationMs: performance.now() - start, fontBytes: fs.statSync(msyh).size }));
    expect(fs.readFileSync(target()).toString("latin1")).toContain("MicrosoftYaHei");
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it("rejects an invalid collection before opening output and preserves the target", async () => {
    const exists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(file => windowsFonts.test(String(file)) ? String(file) === msyh : exists(file));
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => String(file) === msyh ? Buffer.from("invalid TTC") : (read as any)(file, ...args)) as any);
    await expect(execute()).rejects.toThrow();
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(streams).toHaveLength(0);
    expect(documents.every(doc => doc.destroyed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it("preserves old bytes and closes resources after a render failure", async () => {
    noSystemFonts();
    vi.spyOn(PDF.prototype, "text").mockImplementation(() => { throw new Error("PDF_RENDER_FAILED"); });
    await expect(execute()).rejects.toThrow("PDF_RENDER_FAILED");
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(documents.every(doc => doc.destroyed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it.runIf(process.platform === "win32")("preserves old bytes after a real TTC is selected and rendering fails", async () => {
    expect(fs.existsSync(msyh)).toBe(true);
    vi.spyOn(PDF.prototype, "text").mockImplementation(() => { throw new Error("PDF_TTC_RENDER_FAILED"); });
    await expect(execute()).rejects.toThrow("PDF_TTC_RENDER_FAILED");
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(documents.every(doc => doc.destroyed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it("propagates a document stream error and preserves the old target", async () => {
    noSystemFonts();
    const text = PDF.prototype.text;
    let scheduled = false;
    vi.spyOn(PDF.prototype, "text").mockImplementation(function (this: any, ...args: any[]) {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => this.emit("error", new Error("PDF_DOCUMENT_FAILED")));
      }
      return text.apply(this, args as any);
    });
    await expect(execute()).rejects.toThrow("PDF_DOCUMENT_FAILED");
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it("preserves the target and disposes the document after an actual stream open error", async () => {
    noSystemFonts();
    const create = vi.mocked(fs.createWriteStream).getMockImplementation()!;
    vi.mocked(fs.createWriteStream).mockImplementation((file, options) => create(path.dirname(String(file)), options));
    await expect(execute()).rejects.toThrow();
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(documents.every(doc => doc.destroyed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it("preserves the target and removes completed temporary output when replacement fails", async () => {
    noSystemFonts();
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("PDF_REPLACE_FAILED"), { code: "EPERM" }); });
    await expect(execute()).rejects.toThrow("PDF_REPLACE_FAILED");
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(streams.every(stream => stream.closed)).toBe(true);
    expect(temporaryFiles()).toEqual([]);
  });
  it("does not remove another owner's file when exclusive temporary creation collides", async () => {
    noSystemFonts();
    const create = vi.mocked(fs.createWriteStream).getMockImplementation()!;
    let collision = "";
    vi.mocked(fs.createWriteStream).mockImplementation((file, options) => {
      collision = String(file);
      fs.writeFileSync(collision, "other-owner");
      return create(file, options);
    });
    await expect(execute()).rejects.toThrow();
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(fs.readFileSync(collision, "utf8")).toBe("other-owner");
    expect(streams.every(stream => stream.closed)).toBe(true);
  });
});


describe("PDF write batch lifetime and actual output evidence", () => {
  function scope(coordinator: ReturnType<typeof getWorkspaceExecutionCoordinator>, call: string) {
    return { workspaceId: coordinator.workspaceId, parentRunId: "p", groupId: "g", agentId: "a", childRunId: "ca", toolCallId: call };
  }
  it("keeps read excluded through pipeline, rename and temporary cleanup", async () => {
    noSystemFonts();
    const coordinator = getWorkspaceExecutionCoordinator(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let rendering!: () => void;
    const entered = new Promise<void>((resolve) => { rendering = resolve; });
    const end = PDF.prototype.end;
    vi.spyOn(PDF.prototype, "end").mockImplementation(function (this: any, ...args: any[]) {
      rendering();
      void gate.then(() => end.apply(this, args as any));
      return this;
    });
    const writer = coordinator.runLeaf(scope(coordinator, "pdf"), "exclusive", undefined, async (permit) => execute({ coordinator, scope: scope(coordinator, "pdf"), permit }));
    await entered;
    let readEntered = false;
    const reader = coordinator.runLeaf({ ...scope(coordinator, "read"), childRunId: "reader", agentId: "b" }, "shared", undefined, async () => {
      readEntered = true;
      expect(temporaryFiles()).toEqual([]);
      expect(streams.every(stream => stream.closed)).toBe(true);
      return createHash("sha256").update(fs.readFileSync(target())).digest("hex");
    });
    await Promise.resolve();
    expect(readEntered).toBe(false);
    release();
    await writer;
    const sha256 = await reader;
    const writes = coordinator.getWriteEvidence({ toolCallId: "pdf" });
    expect(writes.find(item => item.path === target())).toMatchObject({ state: "applied", after: { sha256 } });
    expect(writes.find(item => item.path !== target())?.after).toEqual({ version: "absent" });
    await coordinator.closeGroup("g");
  });

  it("render failure leaves never-touched final output not_applied and no temporary file", async () => {
    noSystemFonts();
    const coordinator = getWorkspaceExecutionCoordinator(root);
    vi.spyOn(PDF.prototype, "text").mockImplementation(() => { throw new Error("PDF_RENDER_FAILED"); });
    await expect(coordinator.runLeaf(scope(coordinator, "failed-pdf"), "exclusive", undefined, async (permit) => execute({ coordinator, scope: scope(coordinator, "failed-pdf"), permit }))).rejects.toThrow("PDF_RENDER_FAILED");
    const writes = coordinator.getWriteEvidence();
    expect(writes.find(item => item.path === target())?.state).toBe("not_applied");
    expect(fs.readFileSync(target())).toEqual(oldBytes);
    expect(temporaryFiles()).toEqual([]);
    await coordinator.closeGroup("g");
  });
});
