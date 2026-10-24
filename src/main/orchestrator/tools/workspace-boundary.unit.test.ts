import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assertWorkspaceBoundary } from "./workspace-boundary";
import type { ToolContext } from "./registry/tool-context";

// Controlled canonical-path results cover failure branches even on Windows hosts
// that forbid creating reparse points. Real junction integration lives next door.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), lstatSync: vi.fn(actual.lstatSync) };
});

// 实时全局档位固定为 full：这里只验证快照档位本身的规范路径判断。
vi.mock("../../permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permission")>(),
  getCurrentLevel: () => "full",
}));

let fixture: string;
let root: string;
let alias: string;
let outside: string;
let ctx: ToolContext;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-boundary-unit-"));
  root = path.join(fixture, "project");
  alias = path.join(root, "alias");
  outside = path.join(fixture, "other");
  fs.mkdirSync(alias, { recursive: true });
  fs.mkdirSync(outside);
  ctx = { userQuery: "boundary", fileAccessLevel: "scoped", resolvedWorkspaceRoot: root };
});
afterEach(() => {
  vi.mocked(fs.realpathSync).mockRestore();
  vi.mocked(fs.lstatSync).mockRestore();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe("canonical workspace validation", () => {
  it("checks the canonical ancestor before allowing creation of missing descendants", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    vi.mocked(fs.realpathSync).mockImplementation((file) => actual.realpathSync(file === alias ? outside : file));
    expect(() => assertWorkspaceBoundary(path.join(alias, "new", "deep", "file.txt"), "write", ctx))
      .toThrowError(expect.objectContaining({ code: "E_WORKSPACE_BOUNDARY" }));
    expect(() => assertWorkspaceBoundary(path.join(alias, "secret.txt"), "read", { ...ctx, fileAccessLevel: "project-read-only" }))
      .toThrowError(expect.objectContaining({ code: "E_WORKSPACE_BOUNDARY" }));
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("allows canonical internal ancestors and a canonical workspace alias", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    vi.mocked(fs.realpathSync).mockImplementation((file) => actual.realpathSync(file === alias ? root : file));
    expect(() => assertWorkspaceBoundary(path.join(alias, "new", "file.txt"), "write", ctx)).not.toThrow();
    expect(() => assertWorkspaceBoundary(path.join(root, "new.txt"), "write", { ...ctx, resolvedWorkspaceRoot: alias })).not.toThrow();
  });

  it("never falls back past an existing ancestor whose realpath fails (including dangling links)", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    vi.mocked(fs.realpathSync).mockImplementation((file) => {
      if (file === alias) throw Object.assign(new Error("dangling link"), { code: "ENOENT" });
      return actual.realpathSync(file);
    });
    expect(() => assertWorkspaceBoundary(path.join(alias, "new.txt"), "write", ctx))
      .toThrowError(expect.objectContaining({ code: "E_WORKSPACE_BOUNDARY" }));
  });

  it("fails closed for an inaccessible target instead of treating it as a missing file", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    const file = path.join(root, "unreadable.txt");
    vi.mocked(fs.lstatSync).mockImplementation((entry) => {
      if (entry === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actual.lstatSync(entry);
    });
    expect(() => assertWorkspaceBoundary(file, "write", ctx))
      .toThrowError(expect.objectContaining({ code: "E_WORKSPACE_BOUNDARY" }));
  });

  it("fails closed for missing, relative or non-directory workspace roots", () => {
    const file = path.join(fixture, "root-file.txt");
    fs.writeFileSync(file, "original");
    for (const invalidRoot of [path.join(fixture, "missing"), "relative-project", file]) {
      expect(() => assertWorkspaceBoundary(path.join(root, "new.txt"), "write", { ...ctx, resolvedWorkspaceRoot: invalidRoot }))
        .toThrowError(expect.objectContaining({ category: "permission_denied" }));
    }
  });
});
