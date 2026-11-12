import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
vi.mock("electron", () => ({ shell: { openPath: vi.fn() } }));
vi.mock("./chats-store", () => ({ getWorkspaceBinding: () => null }));
const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), spawn: child.spawn }));
import { EventEmitter } from "node:events";
import { parseRegistryDump, expandCandidate, launchDetachedApp, resolveInternals, resolveOpenInApps, type DetectorInternals } from "./open-in-app";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "editor-discovery-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function deps(apps = "", installations = ""): DetectorInternals {
    return { platform: "win32", home: root, env: { LOCALAPPDATA: join(root, "local"), ProgramFiles: join(root, "programs"), PATH: "", PATHEXT: ".EXE" }, run: async (_command, args) => ({ stdout: String(args[1]).includes("App Paths") ? apps : installations, stderr: "" }) };
}
const appKey = (exe: string) => `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
const registration = (exe: string, target: string) => `${appKey(exe)}\n    (默认)    REG_SZ    ${target}\n`;
function touch(file: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ""); }
describe("Windows editor detection inputs", () => {
    it("normalizes localized default values, preserves quoted strings and ignores DWORD values", () => {
        const dump = [appKey("Code.exe"), "    (默认)    REG_SZ    C:\\Editors\\Code.exe", appKey("Cursor.exe"), '    (Default)    REG_EXPAND_SZ    "C:\\Editors\\Cursor.exe"', "    NoRepair    REG_DWORD    0x1", "    DisplayName    REG_SZ    Example Editor"].join("\r\n");
        const parsed = parseRegistryDump(dump);
        expect(parsed.size).toEqual(2);
        expect(parsed.get(appKey("Code.exe"))?.get("(Default)")).toEqual("C:\\Editors\\Code.exe");
        expect(parsed.get(appKey("Cursor.exe"))?.get("(Default)")).toEqual('"C:\\Editors\\Cursor.exe"');
        expect(parsed.get(appKey("Cursor.exe"))?.get("DisplayName")).toEqual("Example Editor");
        expect(parsed.get(appKey("Cursor.exe"))?.has("NoRepair")).toEqual(false);
    });
    it("expands defined variables and the home prefix, rejecting unresolved variables", () => {
        const resolved = resolveInternals(deps());
        expect(expandCandidate("${LOCALAPPDATA}/tools/editor", resolved)).toEqual(`${join(root, "local")}/tools/editor`);
        expect(expandCandidate("${MISSING_ENV}/editor", resolved)).toBeNull();
        expect(expandCandidate("~/bin/editor", resolved)).toEqual(join(root, "bin/editor"));
    });
});
describe("verified launch locations", () => {
    it("uses an existing App Paths executable and omits uninstalled applications", async () => {
        const exe = join(root, "editor", "Code.exe");
        touch(exe);
        const apps = await resolveOpenInApps(deps(registration("Code.exe", exe)));
        expect(apps.get("vscode")?.command).toEqual(exe);
        expect(apps.has("cursor")).toEqual(false);
    });
    it("falls back to the standard install path when registry candidates no longer exist", async () => {
        const fallback = join(root, "local", "Programs", "Microsoft VS Code", "Code.exe");
        touch(fallback);
        const uninstall = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fixture\n    DisplayName    REG_SZ    Microsoft Visual Studio Code\n    InstallLocation    REG_SZ    ${join(root, "removed")}`;
        const apps = await resolveOpenInApps(deps(registration("Code.exe", join(root, "missing", "Code.exe")), uninstall));
        expect(apps.get("vscode")?.command).toEqual(`${join(root, "local")}/Programs/Microsoft VS Code/Code.exe`);
    });
    it("strips the icon index before verifying an uninstall-record executable", async () => {
        const exe = join(root, "custom-editor", "Cursor.exe");
        touch(exe);
        const uninstall = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fixture\n    DisplayName    REG_SZ    Cursor\n    DisplayIcon    REG_SZ    ${exe},0`;
        expect((await resolveOpenInApps(deps("", uninstall))).get("cursor")?.command).toEqual(exe);
    });
    it("returns no applications when no location can be verified", async () => {
        expect((await resolveOpenInApps(deps())).size).toEqual(0);
    });
});
describe("launching an editor", () => {
    it("starts it detached and visible, so its window shows on screen", async () => {
        const handle = Object.assign(new EventEmitter(), { unref: vi.fn() });
        child.spawn.mockReturnValue(handle);
        const launched = launchDetachedApp("Code.exe", ["E:/work"], 1000);
        handle.emit("exit", 0);
        await launched;
        expect(child.spawn).toHaveBeenCalledWith("Code.exe", ["E:/work"], { detached: true, stdio: "ignore", windowsHide: false });
        expect(handle.unref).toHaveBeenCalled();
    });
});
