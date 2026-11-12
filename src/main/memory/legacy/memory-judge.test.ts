import { beforeEach, describe, it, expect, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("./memory-llm-client", () => ({ getDefaultMaxOutputTokens: () => 800, invokeMemoryStructuredOutput: request }));
vi.mock("./memory-llm-shared", () => ({ loadMemoryModelConfig: () => ({ source: "inherited-main", provider: "test-provider", baseUrl: "https://model.invalid", model: "memory-model", apiKey: "fixture-credential" }) }));
import { MemoryJudge } from "./memory-judge";
beforeEach(() => { request.mockReset(); request.mockResolvedValue({ candidates: [], entities: [] }); });
describe("memory extraction instructions", () => {
    it("requests an object envelope and explicit L2 title and quote constraints", async () => {
        await new MemoryJudge().judge("I study astronomy on weekends", "I understand", "judge-session-73");
        expect(request).toHaveBeenCalledTimes(1);
        const prompt: string = request.mock.calls[0][0].systemPrompt;
        for (const clause of [
            "顶层 JSON 对象", '{"candidates":[],"entities":[]}', "L2 slug 抽取", "L2 片段必须输出 slug",
            "禁止标点、引号、空格、emoji", "L0 / L1 候选不要输出 slug 字段", "L2 sourceQuote 抽取",
            "L2 片段必须输出 sourceQuote", "允许标点、空格、emoji", "L0 / L1 候选不要输出 sourceQuote 字段",
        ])
            expect(prompt).toContain(clause);
        expect(prompt).toMatch(/≤20\s*字/);
        expect(prompt).toMatch(/500\s*字/);
        expect(prompt).not.toContain("输出格式为 JSON 数组");
    });
});
