import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profile = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => profile.directory } }));
beforeEach(() => { profile.directory = mkdtempSync(join(tmpdir(), "dmae-persistence-")); vi.resetModules(); });
afterEach(() => rmSync(profile.directory, { recursive: true, force: true }));
describe("persisted L2 activation state", () => {
    it("initializes keywords and an archived zero-activation state alongside each new memory", async () => {
        const { memoryStore } = await import("./memory-store");
        const memory = await memoryStore.addL2Memory({ content: "我喜欢在清晨阅读小说", triggerText: "清晨阅读小说", sourceConversationId: "reading-session", isPinned: false });
        expect(memory.keywords!.length).toBeGreaterThan(0);
        expect(memory.keywords).toContain("阅");
        const state = await memoryStore.getL2DmaeState(memory.id);
        expect(state).toBeDefined();
        expect(state).toMatchObject({ activation: 0, state: "archived" });
        const disk = JSON.parse(readFileSync(join(profile.directory, "memory.json"), "utf8"));
        expect(disk.l2[0].keywords).toEqual(memory.keywords);
        expect(disk.l2DmaeStates).toHaveLength(1);
        expect(disk.l2DmaeStates[0].l2Id).toEqual(memory.id);
    });
    it("stores updated activation, intrinsic value and active status", async () => {
        const { memoryStore } = await import("./memory-store");
        const memory = await memoryStore.addL2Memory({ content: "夏季学习游泳", triggerText: "学习游泳", sourceConversationId: "summer-session", isPinned: false });
        await memoryStore.updateL2DmaeState(memory.id, { activation: 80, intrinsicValue: 36, userSilence: 2, modelSilence: 1, state: "active" });
        expect(await memoryStore.getL2DmaeState(memory.id)).toMatchObject({ activation: 80, intrinsicValue: 36, userSilence: 2, modelSilence: 1, state: "active" });
    });
    it("reads activation states saved with the engine's capitalized names as lowercase", async () => {
        const { createDefaultMemoryStore } = await import("./memory-store-defaults");
        const stored = createDefaultMemoryStore();
        const base = { activation: 0, intrinsicValue: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] };
        stored.l2DmaeStates = [
            { ...base, l2Id: "was-active", state: "Active" },
            { ...base, l2Id: "was-dormant", state: "Dormant" },
            { ...base, l2Id: "was-archived", state: "Archived" },
            { ...base, l2Id: "already-lower", state: "active" },
        ] as never;
        writeFileSync(join(profile.directory, "memory.json"), JSON.stringify(stored));
        const { memoryStore } = await import("./memory-store");
        expect((await memoryStore.getAllL2DmaeStates()).map(s => [s.l2Id, s.state])).toEqual([
            ["was-active", "active"], ["was-dormant", "dormant"], ["was-archived", "archived"], ["already-lower", "active"],
        ]);
        await memoryStore.updateL2DmaeState("was-dormant", { activation: 1 });
        const disk = JSON.parse(readFileSync(join(profile.directory, "memory.json"), "utf8"));
        expect(disk.l2DmaeStates.map((s: { state: string }) => s.state)).toEqual(["active", "dormant", "archived", "active"]);
    });
});
