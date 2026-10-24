import { describe, expect, it, vi } from "vitest";
import { ensureGpuSandboxAcl } from "./gpu-sandbox-acl";
function options(acl = "") {
    return { platform: "win32" as NodeJS.Platform, isPackaged: true, exeDir: "E:\\Desktop Apps\\Firefly", userDataDir: "C:\\Profiles\\agent", queryAcl: vi.fn(() => acl), runCommand: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn() };
}
describe("GPU sandbox access repair decisions", () => {
    it("avoids queries and commands outside packaged Windows", () => {
        const deps = options();
        expect(ensureGpuSandboxAcl({ ...deps, platform: "linux" })).toEqual("skipped_platform");
        expect(ensureGpuSandboxAcl({ ...deps, isPackaged: false })).toEqual("skipped_dev");
        expect(deps.runCommand).not.toHaveBeenCalled();
        expect(deps.queryAcl).not.toHaveBeenCalled();
    });
    it("skips a previously recorded successful repair", () => {
        const deps = options();
        deps.existsSync.mockReturnValue(true);
        expect(ensureGpuSandboxAcl(deps)).toEqual("skipped_sentinel");
        expect(deps.runCommand).not.toHaveBeenCalled();
    });
    it.each(["ALL RESTRICTED APPLICATION PACKAGES:(RX)", "*S-1-15-2-2:(OI)(CI)(RX)"])("recognizes existing sandbox access %s", acl => {
        const deps = options(acl);
        expect(ensureGpuSandboxAcl(deps)).toEqual("already_ok");
        expect(deps.runCommand).not.toHaveBeenCalled();
        expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    });
    it.each([false, true])("attempts a quoted SID grant even if the query throws=%s", queryFails => {
        const deps = options("BUILTIN\\Users:(F)");
        if (queryFails)
            deps.queryAcl.mockImplementation(() => { throw new Error("ACL utility unavailable"); });
        expect(ensureGpuSandboxAcl(deps)).toEqual("granted");
        expect(deps.runCommand).toHaveBeenCalledExactlyOnceWith('icacls "E:\\Desktop Apps\\Firefly" /grant *S-1-15-2-2:(OI)(CI)(RX) /C');
        expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    });
    it("returns failure without writing a sentinel when the grant is denied", () => {
        const deps = options();
        deps.runCommand.mockImplementation(() => { throw new Error("permission denied"); });
        expect(ensureGpuSandboxAcl(deps)).toEqual("failed");
        expect(deps.writeFileSync).not.toHaveBeenCalled();
    });
});
