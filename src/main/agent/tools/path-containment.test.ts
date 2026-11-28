import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { resolveContainedPath } from "./path-containment";

vi.mock("fs", () => ({ realpathSync: vi.fn(), lstatSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const root = path.resolve("fixture/workspace");
const outside = path.resolve("fixture/outside");
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });

describe("realpath containment with controlled filesystem resolution", () => {
  it("rejects lexical traversal and prefix collisions before filesystem access", () => {
    expect(resolveContainedPath(root, "../outside/file")).toBeNull();
    expect(resolveContainedPath(root, `${root}-other/file`)).toBeNull();
    expect(fs.realpathSync).not.toHaveBeenCalled();
  });

  it.each(["exports/file.txt", "exports/new/nested/file.txt"])("rejects an outside existing ancestor: %s", (target) => {
    vi.mocked(fs.lstatSync).mockReturnValue({} as fs.Stats);
    vi.mocked(fs.realpathSync).mockImplementation((file) => String(file) === root ? root : outside);
    expect(resolveContainedPath(root, target)).toBeNull();
  });

  it("rejects an outside ancestor even if the final target would resolve back inside", () => {
    vi.mocked(fs.lstatSync).mockReturnValue({} as fs.Stats);
    vi.mocked(fs.realpathSync).mockImplementation((file) => String(file) === path.join(root, "exports") ? outside : root);
    expect(resolveContainedPath(root, "exports/return/file")).toBeNull();
  });

  it.each(["report.txt", "nested/report.txt"])("rejects an outside final file link: %s", (target) => {
    vi.mocked(fs.lstatSync).mockReturnValue({} as fs.Stats);
    vi.mocked(fs.realpathSync).mockImplementation((file) => String(file) === path.join(root, target) ? outside : String(file));
    expect(resolveContainedPath(root, target)).toBeNull();
  });

  it("fails closed when an ancestor cannot be inspected", () => {
    vi.mocked(fs.realpathSync).mockReturnValue(root);
    vi.mocked(fs.lstatSync).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(resolveContainedPath(root, "new/file")).toBeNull();
  });

  it("permits an internal link and resolves its missing suffix", () => {
    vi.mocked(fs.lstatSync).mockImplementation((file) => {
      if (String(file) !== path.join(root, "alias")) throw missing();
      return {} as fs.Stats;
    });
    vi.mocked(fs.realpathSync).mockImplementation((file) => String(file) === root ? root : path.join(root, "real"));
    expect(resolveContainedPath(root, "alias/new/file")).toBe(path.join(root, "real/new/file"));
  });

  it("accepts a trusted root that is itself a link", () => {
    vi.mocked(fs.realpathSync).mockReturnValue(outside);
    vi.mocked(fs.lstatSync).mockImplementation(() => { throw missing(); });
    expect(resolveContainedPath(root, "new/file")).toBe(path.join(outside, "new/file"));
  });

  it.each(["ENOENT", "ELOOP", "EACCES"])("fails closed for a dangling or unresolvable link: %s", (code) => {
    vi.mocked(fs.lstatSync).mockReturnValue({} as fs.Stats);
    vi.mocked(fs.realpathSync).mockImplementation((file) => {
      if (String(file) === root) return root;
      throw Object.assign(new Error("cannot resolve link"), { code });
    });
    expect(resolveContainedPath(root, "link/file")).toBeNull();
  });
});
