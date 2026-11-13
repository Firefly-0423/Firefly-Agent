import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, readFile } from "./workspace-files-ipc";
let parent: string;
let root: string;
beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "preview-contract-"));
    root = join(parent, "workspace");
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "entry.ts"), "export const answer = 17;\n");
    writeFileSync(join(root, "guide.md"), "# Usage\n");
    writeFileSync(join(root, ".private"), "hidden");
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));
describe("workspace file preview contract", () => {
    it("lists directories before visible files and returns portable relative paths", async () => {
        const listing = await listDirectory(root, "");
        expect(listing).toEqual({ ok: true, entries: [{ name: "lib", relPath: "lib", isDir: true }, { name: "guide.md", relPath: "guide.md", isDir: false }], truncated: false });
        const nested = await listDirectory(root, "lib");
        expect(nested).toEqual({ ok: true, entries: [{ name: "entry.ts", relPath: "lib/entry.ts", isDir: false }], truncated: false });
        expect(await readFile(root, "lib/entry.ts")).toMatchObject({ ok: true, content: "export const answer = 17;\n" });
    });
    it("rejects traversal, injected absolute paths and nonexistent directories", async () => {
        expect(await listDirectory(root, "../")).toEqual({ ok: false, code: "OUT_OF_ROOT" });
        expect(await listDirectory(root, "not-present")).toEqual({ ok: false, code: "NOT_FOUND" });
        const absolute = await listDirectory(root, "C:/Windows");
        expect(absolute.ok).toEqual(false);
        if (!absolute.ok)
            expect(["OUT_OF_ROOT", "NOT_FOUND"]).toContain(absolute.code);
    });
    it("rejects directories, binary content and files one byte over the preview limit", async () => {
        writeFileSync(join(root, "data.bin"), Buffer.alloc(8192));
        writeFileSync(join(root, "over-limit.txt"), "s".repeat(1024 * 1024 + 1));
        expect(await readFile(root, "lib")).toEqual({ ok: false, code: "IS_DIRECTORY" });
        expect(await readFile(root, "data.bin")).toEqual({ ok: false, code: "BINARY" });
        expect(await readFile(root, "over-limit.txt")).toEqual({ ok: false, code: "TOO_LARGE" });
    });
    it("rejects a symbolic link escaping the bound root when links are available", async () => {
        const outside = join(parent, "outside.txt");
        const alias = join(root, "linked.txt");
        writeFileSync(outside, "outside the binding");
        try {
            symlinkSync(outside, alias);
        }
        catch (error) {
            if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw error;
        }
        if (existsSync(alias))
            expect(await readFile(root, "linked.txt")).toEqual({ ok: false, code: "OUT_OF_ROOT" });
    });
});
