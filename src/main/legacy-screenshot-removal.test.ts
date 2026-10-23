import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/ipc-channels";
describe("native screenshot product boundary", () => {
    it("does not publish any former overlay channel", () => {
        const suffixes = ["CONFIRM", "SHOWN", "START_SESSION", "FRAME_READY", "CANCEL", "REGION", "RENDERED", "DATA", "OVERLAY_READY"];
        for (const suffix of suffixes)
            expect(IPC).not.toHaveProperty(`SCREENSHOT_${suffix}`);
    });
    it("ships neither overlay UI files nor a renderer build entry", () => {
        const retired = ["src/preload/screenshot.ts", "src/main/screenshot/screenshot-manager.ts", ...["ts", "css"].map(ext => `src/renderer/screenshot/screenshot.${ext}`), "src/renderer/screenshot/index.html"];
        expect(retired.filter(file => existsSync(resolve(file)))).toEqual([]);
        const bundler = readFileSync(resolve("vite.config.ts"), "utf8");
        expect(bundler).not.toContain("src/renderer/screenshot");
        expect(bundler).not.toMatch(/\bscreenshot\s*:/);
    });
    it("does not use Electron desktop capture APIs or construct capture windows", () => {
        const folder = resolve("src/main/screenshot");
        const production = readdirSync(folder).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"));
        for (const file of production)
            expect(readFileSync(resolve(folder, file), "utf8"), file).not.toMatch(/\bdesktopCapturer\b|\bgetDisplayMedia\b|new\s+BrowserWindow\s*\(/);
    });
});
