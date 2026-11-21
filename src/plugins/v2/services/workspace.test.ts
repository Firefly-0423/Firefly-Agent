import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWorkspaceFile } from "./workspace";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
let temp: string, root: string, outside: string;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "firefly-services-"));
  root = path.join(temp, "project"); outside = path.join(temp, "private");
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "hello.txt"), "你好");
  await fs.writeFile(path.join(outside, "secret.txt"), "private-key");
});
afterEach(async () => { vi.mocked(fs.open).mockClear(); await fs.rm(temp, { recursive: true, force: true }); });
describe("workspace file boundary with real files", () => {
  it("reads bounded UTF-8 from the bound project", async () => {
    expect(await readWorkspaceFile(root, "sub/hello.txt", signal())).toBe("你好");
  });
  it.each(["../private/secret.txt", "/private/secret.txt", "C:/private/secret.txt", "\\\\server\\share", "sub/../hello.txt", "sub\\hello.txt", "hello.txt:stream", "sub//hello.txt", ".", ""])("rejects invalid relative path %j before opening any file", async relative => {
    await expect(readWorkspaceFile(root, relative, signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it("rejects directories, missing files and oversized files without opening", async () => {
    await fs.writeFile(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
    await expect(readWorkspaceFile(root, "sub", signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    await expect(readWorkspaceFile(root, "missing.txt", signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    await expect(readWorkspaceFile(root, "large.txt", signal())).rejects.toMatchObject({ code: "ERR_INVALID_ARGUMENT" });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it("rejects non-UTF8 bytes and respects cancellation", async () => {
    await fs.writeFile(path.join(root, "binary"), Buffer.from([0xff]));
    await expect(readWorkspaceFile(root, "binary", signal())).rejects.toMatchObject({ code: "ERR_INVALID_ARGUMENT" });
    vi.mocked(fs.open).mockClear(); const abort = new AbortController(); abort.abort();
    await expect(readWorkspaceFile(root, "sub/hello.txt", abort.signal)).rejects.toMatchObject({ code: "ERR_CANCELLED" });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it.for(["junction", "dir"] as const)("rejects real %s in an intermediate segment", async (type, context) => {
    const link = path.join(root, "link");
    try { await fs.symlink(outside, link, type); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip("OS denies symlink creation without developer mode or privilege"); return; }
      throw error;
    }
    await expect(readWorkspaceFile(root, "link/secret.txt", signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it("rejects a bound root that is itself a junction", async () => {
    const link = path.join(temp, "bound-link"); await fs.symlink(root, link, "junction");
    await expect(readWorkspaceFile(link, "sub/hello.txt", signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it("rejects replacement between checking the filename and opening the handle", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const target = path.join(root, "sub", "hello.txt");
      await fs.rename(target, `${target}.original`);
      await fs.copyFile(path.join(outside, "secret.txt"), target);
      return actual.open(...args);
    });
    await expect(readWorkspaceFile(root, "sub/hello.txt", signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
  });
  it("rejects an ancestor switched to a junction while opening", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await fs.writeFile(path.join(outside, "hello.txt"), "private-key");
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(path.join(root, "sub"), path.join(root, "original"));
      await fs.symlink(outside, path.join(root, "sub"), "junction");
      return actual.open(...args);
    });
    await expect(readWorkspaceFile(root, "sub/hello.txt", signal())).rejects.toMatchObject({ code: "ERR_PERMISSION" });
  });
});
