import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ screen: {} }));
import { computePanelLayout } from "./windows/window-layout";
const windows = [{ width: 1280, height: 760 }, { width: 320, height: 760 }, { width: 320, height: 760 }];
describe("panel visibility across desktop sizes", () => {
    it.each([
        [2560, 1440, 340], [1920, 1080, 160], [1366, 768, 4], [1280, 720, 0],
    ])("places all panels on a %i by %i work area", (width, height, expectedTop) => {
        const desktop = { x: 0, y: 0, width, height };
        const placements = computePanelLayout(desktop, windows);
        expect(placements.length).toEqual(3);
        expect(placements[0].y).toEqual(expectedTop);
        if (height >= 760)
            expect(placements[0].y).toBeGreaterThan(0);
        placements.forEach((point, index) => {
            const panel = windows[index];
            const horizontal = Math.min(width, point.x + panel.width) - Math.max(0, point.x);
            const vertical = Math.min(height, point.y + panel.height) - Math.max(0, point.y);
            expect(horizontal).toBeGreaterThanOrEqual(120);
            expect(vertical).toBeGreaterThanOrEqual(80);
        });
    });
});
