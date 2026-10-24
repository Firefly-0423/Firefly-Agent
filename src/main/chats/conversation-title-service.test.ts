import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import type { ModelSettings } from "../settings/model-settings";
import { createConversationTitleService } from "./conversation-title-service";
afterEach(() => vi.useRealTimers());
function fixture(output = "旅行路线规划", busy = false, usableEndpoint = true) {
    let session = { id: "title-session", title: "请帮我安排一条沿海旅行路线", identityId: null, messages: [{ id: "initial-question", role: "user", content: "请帮我安排一条沿海旅行路线[sticker:smile]", at: 9, attachments: [{ kind: "image", name: "coast-map.png", filePath: "E:\\fixtures\\coast-map.png", mime: "image/png", status: "pending" }] }], createdAt: 9, updatedAt: 9, schemaVersion: 1, mode: "work" } as ChatSession;
    const settings = { provider: "openai", baseUrl: usableEndpoint ? "https://title.invalid/v1" : "", model: "title-fixture", apiKey: "title-key" } as ModelSettings;
    const generate = vi.fn(async () => ({ text: output, finishReason: "stop" }));
    const write = vi.fn((_id: string, _message: string, title: string) => { session = { ...session, title }; return true; });
    const service = createConversationTitleService({ getSession: () => session, setGeneratedTitle: write, resolveSettings: () => settings, llmClient: { chatNonStream: generate }, enqueueTask: async (_name, task) => task(), onTitleChanged: vi.fn(), isPrimaryModelBusy: () => busy });
    return { service, generate, write, read: () => session, idle: () => { busy = false; }, request: { sessionId: session.id, userMessageId: "initial-question", text: "请帮我安排一条沿海旅行路线" } };
}
describe("background conversation titles", () => {
    it("waits exactly three seconds and sends only visible user text with reasoning off", async () => {
        vi.useFakeTimers();
        const f = fixture();
        expect(f.service.schedule(f.request)).toEqual(true);
        await vi.advanceTimersByTimeAsync(2999);
        expect(f.generate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.generate).toHaveBeenCalledTimes(1);
        const args = f.generate.mock.calls[0] as unknown as any[];
        expect(args[1].at(-1)).toEqual({ role: "user", content: f.request.text });
        const prompt = args[1].map((message: any) => message.content).join("\n");
        expect(prompt).not.toContain("coast-map.png");
        expect(prompt).not.toContain("sticker:smile");
        expect(args[2]).toBeUndefined();
        expect(args[5]).toEqual({ mode: "off" });
        expect(f.read().title).toEqual("旅行路线规划");
    });
    it("does not schedule the same conversation twice", () => {
        vi.useFakeTimers();
        const f = fixture();
        expect(f.service.schedule(f.request)).toEqual(true);
        expect(f.service.schedule(f.request)).toEqual(false);
        expect(vi.getTimerCount()).toEqual(1);
    });
    it("removes model title wrappers before storing", async () => {
        vi.useFakeTimers();
        const f = fixture("标题：**「旅行路线规划」**\n");
        f.service.schedule(f.request);
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.read().title).toEqual("旅行路线规划");
    });
    it("keeps the temporary title for an output shorter than five characters", async () => {
        vi.useFakeTimers();
        const f = fixture("旅行");
        f.service.schedule(f.request);
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.write).not.toHaveBeenCalled();
        expect(f.read().title).toEqual("请帮我安排一条沿海旅行路线");
    });
    it("does not request a title without a usable endpoint", async () => {
        vi.useFakeTimers();
        const f = fixture("旅行路线规划", false, false);
        f.service.schedule(f.request);
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.generate).not.toHaveBeenCalled();
    });
    it("waits for the next full retry interval after the primary model becomes idle", async () => {
        vi.useFakeTimers();
        const f = fixture("旅行路线规划", true);
        f.service.schedule(f.request);
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.generate).not.toHaveBeenCalled();
        f.idle();
        await vi.advanceTimersByTimeAsync(2999);
        expect(f.generate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.generate).toHaveBeenCalledTimes(1);
    });
});
