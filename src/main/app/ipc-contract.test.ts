import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it, expect } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { collectReachableFiles, findIpcChannelUses, type IpcChannelUse, type IpcChannelUseKind } from "./ipc-contract-scanner";
const root = process.cwd();
const portable = (file: string) => relative(root, file).split(sep).join("/");
function scan(folder: string): IpcChannelUse[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
        const file = join(folder, entry.name);
        if (entry.isDirectory())
            return scan(file);
        if (!/\.tsx?$/.test(entry.name) || /\.(test|spec|d)\.tsx?$/.test(entry.name))
            return [];
        return findIpcChannelUses(portable(file), readFileSync(file, "utf8"));
    });
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
        const bridge = readFileSync(join(root, "src/preload/index.ts"), "utf8");
        expect(bridge).not.toContain('exposeInMainWorld("moments"');
        expect(bridge).not.toContain('exposeInMainWorld("call"');
        expect(bridge).not.toContain("openCall:");
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
