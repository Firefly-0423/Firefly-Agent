import { describe, it, expect, vi } from "vitest";
import { prepareBeforeReady } from "./pre-ready";
describe("synchronous Electron preparation", () => {
    it.each([true, false])("runs only primary-process setup when lock result is %s", primary => {
        const steps: string[] = [];
        const request = vi.fn();
        let secondInstance!: () => void;
        const result = prepareBeforeReady({
            activation: { request },
            configureDocumentIndex: () => { steps.push("index"); },
            installSingleInstance: listener => { steps.push("lock"); secondInstance = listener; return primary; },
            registerPrivilegedSchemes: () => { steps.push("protocols"); },
            ensureGpuSandboxAcl: () => { steps.push("permissions"); },
        });
        expect(result).toEqual({ isPrimaryProcess: primary });
        expect(steps).toEqual(primary ? ["index", "lock", "protocols", "permissions"] : ["index", "lock"]);
        secondInstance();
        expect(request.mock.calls).toEqual([[{ kind: "chat" }]]);
    });
});
