import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, relative, sep } from "node:path";
import { describe, it, expect } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { collectReachableFiles, findIpcChannelUses, type IpcChannelUse, type IpcChannelUseKind } from "./ipc-contract-scanner.test-support";
const root = process.cwd();
const portable = (file: string) => relative(root, file).split(sep).join("/");
function collectProductionSourceFiles(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
        const file = join(folder, entry.name);
        if (entry.isDirectory())
            return collectProductionSourceFiles(file);
        if (!/\.tsx?$/.test(entry.name) || /\.(test|spec|d)\.tsx?$/.test(entry.name))
            return [];
        return [file];
    });
}
function scan(folder: string): IpcChannelUse[] {
    return collectProductionSourceFiles(folder).flatMap(file =>
        findIpcChannelUses(portable(file), readFileSync(file, "utf8")),
    );
}
const preload = scan(join(root, "src/preload"));
const main = ["src/main", "src/plugins"].flatMap(folder => scan(join(root, folder)));
const uses = (all: IpcChannelUse[], kind: IpcChannelUseKind) => all.filter(use => use.kind === kind);
const keys = (all: IpcChannelUse[]) => [...new Set(all.map(use => use.channel))].sort();
describe("IPC production wiring", () => {
    it.each([
        ["invoke", "handle", 100], ["send", "on", 10], ["listen", "outbound", 20],
    ] as const)("matches preload %s to main %s", (from, to, minimum) => {
        const client = keys(uses(preload, from));
        const server = keys(uses(main, to));
        expect(client.length).toBeGreaterThan(minimum);
        expect(server.length).toBeGreaterThan(minimum);
        expect(client.filter(key => !server.includes(key))).toEqual([]);
        if (to === "outbound")
            expect(server.filter(key => !client.includes(key))).toEqual([]);
    });
    it("registers each invoke channel once", () => {
        const handlers = uses(main, "handle");
        expect(keys(handlers).filter(channel => handlers.filter(use => use.channel === channel).length > 1)).toEqual([]);
    });
    it("reaches all registrations and outbound sites from the composition root", () => {
        const reachable = new Set([...collectReachableFiles(join(root, "src/main/index.ts"))].map(portable));
        const registrationFiles = [...new Set(main.filter(use => ["handle", "on", "outbound"].includes(use.kind)).map(use => use.file))].sort();
        expect(registrationFiles.length).toBeGreaterThan(20);
        expect(registrationFiles.filter(file => !reachable.has(file))).toEqual([]);
    });
    it("does not expose retired Moments or Call entry points", () => {
        expect(Object.values(IPC).filter(channel => channel.startsWith("moments:") || channel.startsWith("call:") || channel === "sidebar:open-call")).toEqual([]);
        const preloadDir = join(root, "src/preload");
        expect(existsSync(join(preloadDir, "index.ts"))).toBe(true);
        const preloadFiles = collectProductionSourceFiles(preloadDir).map(portable).sort();
        expect(preloadFiles).toContain("src/preload/index.ts");
        for (const file of preloadFiles) {
            const bridge = readFileSync(join(root, file), "utf8");
            expect(bridge, file).not.toMatch(/exposeInMainWorld\s*\(\s*["']moments["']/);
            expect(bridge, file).not.toMatch(/exposeInMainWorld\s*\(\s*["']call["']/);
            expect(bridge, file).not.toContain("openCall:");
        }
    });
    it("recursively collects nested preload source files while excluding test and declaration files", () => {
        const tempDir = mkdtempSync(join(os.tmpdir(), "ipc-contract-preload-"));
        try {
            mkdirSync(join(tempDir, "settings"), { recursive: true });
            writeFileSync(join(tempDir, "index.ts"), "export {};", "utf8");
            writeFileSync(join(tempDir, "settings/core.ts"), "export {};", "utf8");
            writeFileSync(join(tempDir, "settings/core.test.ts"), "export {};", "utf8");
            writeFileSync(join(tempDir, "settings/core.spec.ts"), "export {};", "utf8");
            writeFileSync(join(tempDir, "settings/types.d.ts"), "export {};", "utf8");
            writeFileSync(join(tempDir, "settings/notes.md"), "ignored", "utf8");

            const collected = collectProductionSourceFiles(tempDir)
                .map(file => relative(tempDir, file).split(sep).join("/"))
                .sort();
            expect(collected).toEqual(["index.ts", "settings/core.ts"]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
describe("IPC expression recognition", () => {
    it("retains direction and source order while excluding comments, strings and dynamic channels", () => {
        const program = [
            "ipcRenderer.invoke(IPC.QUERY);", "ipcRenderer.send(IPC.REQUEST);", "ipcRenderer.on(IPC.UPDATE, cb);",
            "ipcRenderer.removeListener(IPC.UPDATE, cb);", "scope.handle(IPC.RESULT, cb);", "scope.on(IPC.INPUT, cb);",
            "window.webContents.send(IPC.PROGRESS, data);", "sendToPetWindow(IPC.PET_UPDATE, data);", "runtime.registerIpc(IPC.PLUGIN_QUERY, cb);",
            "/* scope.handle(IPC.FAKE_BLOCK, cb); */", 'const example = "scope.handle(IPC.FAKE_STRING, cb)";',
            "sendToPetWindow(unknownChannel, data);", "webContents.send(unknownChannel, data);",
        ].join("\n");
        const found = findIpcChannelUses("wiring-fixture.ts", program);
        expect(found.map(({ kind, channel }) => [kind, channel])).toEqual([
            ["invoke", "QUERY"], ["send", "REQUEST"], ["listen", "UPDATE"], ["listen", "UPDATE"], ["handle", "RESULT"],
            ["on", "INPUT"], ["outbound", "PROGRESS"], ["outbound", "PET_UPDATE"], ["handle", "PLUGIN_QUERY"],
        ]);
    });
});
