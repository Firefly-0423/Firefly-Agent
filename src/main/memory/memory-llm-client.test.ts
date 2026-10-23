import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
const boundary = vi.hoisted(() => ({ config: { provider: "fixture-vendor", model: "memory-fixture", baseUrl: "https://memory.invalid/v1", apiKey: "test-secret" }, requests: [] as any[] }));
vi.mock("electron", () => ({ app: { getPath: () => "unused-memory-profile" } }));
vi.mock("../runtime-policy", () => ({ resolveTimeoutPolicy: () => ({ totalMs: 30000 }), resolveMaxOutputTokens: ({ stage }: {
        stage: string;
    }) => ({ "memory-judge": 800, "memory-compressor": 500, "memory-reflect": 500, "memory-resolver": 700 }[stage] ?? 500) }));
vi.mock("./memory-llm-shared", () => ({ loadMemoryModelConfig: () => boundary.config, stripThinkBlocks: (text: string) => text }));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("../orchestrator/vendors", () => ({ getAdapterForConfig: () => ({
        buildRequest: (request: unknown, config: {
            model: string;
        }) => { boundary.requests.push(request); return { url: "https://memory.invalid/v1/chat/completions", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model }) }; },
        parseResponse: (data: any) => ({ text: data.text ?? "", finishReason: data.finishReason ?? "stop", usage: data.usage }),
    }) }));
import { invokeMemoryLlm, invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client";
import { MemoryLlmTimeoutError, MemoryLlmHttpError, MemoryLlmProtocolError, MemoryLlmConfigurationError } from "./memory-llm-errors";
import { parseMemoryJudgeResult, validateMemoryJudgeBusiness, parseMemoryReflectionResult, validateMemoryReflectionBusiness } from "./memory-schemas";
beforeEach(() => { boundary.requests = []; boundary.config.apiKey = "test-secret"; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("structured memory repair", () => {
    it.each(["judge", "reflect"] as const)("adds operation-specific feedback for %s", async (operation) => {
        const responses = ["invalid-output", operation === "judge" ? '{"candidates":[]}' : '{"updates":[]}'];
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ text: responses.shift(), finishReason: "stop" }) })));
        const result = operation === "judge"
            ? await invokeMemoryStructuredOutput({ operation, systemPrompt: "Extract reliable facts", userPrompt: "A conversation", maxOutputTokens: 800, parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness })
            : await invokeMemoryStructuredOutput({ operation, systemPrompt: "Review recent facts", userPrompt: "A conversation", maxOutputTokens: 500, parseSchema: parseMemoryReflectionResult, validateBusiness: validateMemoryReflectionBusiness });
        expect(result).toEqual(operation === "judge" ? { candidates: [], entities: [] } : []);
        const feedback: string = boundary.requests[1].messages.at(-1).content;
        if (operation === "judge") {
            expect(feedback).toContain("NO_JSON_OBJECT");
            expect(feedback).toContain('{"candidates":[],"entities":[]}');
        }
        else {
            expect(feedback).toContain('{"updates":[...]}');
            expect(feedback).not.toContain('{"groups":[...]}');
        }
    });
    it("uses the configured token budget for each operation", () => {
        expect(["judge", "compress", "reflect", "resolve"].map(operation => getDefaultMaxOutputTokens(operation as any))).toEqual([800, 500, 500, 700]);
    });
});
describe("memory model failure contracts", () => {
    it("preserves diagnostic names, operation and error-specific fields", () => {
        const timeout = new MemoryLlmTimeoutError(30000, "judge");
        expect(timeout).toBeInstanceOf(Error);
        expect(timeout).toMatchObject({ name: "MemoryLlmTimeoutError", timeoutMs: 30000, operation: "judge" });
        expect(timeout.message).toContain("judge");
        expect(timeout.message).toContain("30000");
        const http = new MemoryLlmHttpError(401, "compress", "Not authorized");
        expect(http).toBeInstanceOf(Error);
        expect(http).toMatchObject({ name: "MemoryLlmHttpError", statusCode: 401, operation: "compress", responseBody: "Not authorized" });
        expect(http.message).toContain("401");
        expect(http.message).toContain("compress");
        expect(new MemoryLlmHttpError(500, "resolve").responseBody).toBeUndefined();
        const protocol = new MemoryLlmProtocolError("resolve", "missing response text");
        expect(protocol).toBeInstanceOf(Error);
        expect(protocol).toMatchObject({ name: "MemoryLlmProtocolError", operation: "resolve", detail: "missing response text" });
        const configuration = new MemoryLlmConfigurationError("credential unavailable");
        expect(configuration).toBeInstanceOf(Error);
        expect(configuration.name).toEqual("MemoryLlmConfigurationError");
        expect(configuration.message).toContain("credential unavailable");
    });
    it("rejects calls with a missing API key", async () => {
        boundary.config.apiKey = "";
        await expect(invokeMemoryLlm({ operation: "judge", messages: [{ role: "user", content: "Input" }], maxOutputTokens: 800 })).rejects.toThrow(MemoryLlmConfigurationError);
    });
    it("distinguishes external cancellation from a model timeout", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
        })));
        const caller = new AbortController();
        const pending = invokeMemoryLlm({ operation: "judge", messages: [{ role: "user", content: "Input" }], maxOutputTokens: 800, signal: caller.signal });
        const message = expect(pending).rejects.toThrow(/cancelled by external signal/);
        const type = expect(pending).rejects.not.toThrow(MemoryLlmTimeoutError);
        caller.abort();
        await Promise.all([message, type]);
    });
    it("caps HTTP diagnostic text at 1500 characters plus the truncation suffix", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "d".repeat(5000) } }) })));
        const outcome = invokeMemoryLlm({ operation: "compress", messages: [{ role: "user", content: "Input" }], maxOutputTokens: 500 });
        await expect(outcome).rejects.toBeInstanceOf(MemoryLlmHttpError);
        const error = await outcome.catch(error => error as MemoryLlmHttpError);
        expect(error.responseBody).toContain("…(truncated)");
        expect(error.responseBody.length).toBeLessThanOrEqual(1520);
    });
});
