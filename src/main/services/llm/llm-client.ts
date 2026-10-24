import type { ModelSettings } from "../../settings/model-settings";
import { getAdapterForConfig, createSseReader } from "../../orchestrator/vendors";
import type { StructuredOutputRequest, VendorConfig } from "../../orchestrator/vendors";
import { createVisibleStreamFilter, stripThinkBlocks } from "../../chat/chat-stream-utils";
import { recordUsage, recordRequest } from "../../token-usage-store";
import { appendApiLog } from "../../chat/chat-api-utils";
type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};
type CallHead = [
    settings: ModelSettings,
    messages: ChatMessage[],
    temperature: number | undefined,
    timeoutMs: number,
    label: string
];
type NonStreamOptions = {
    structuredOutput?: StructuredOutputRequest;
    maxTokens?: number;
    extraBody?: Record<string, unknown>;
};
type NonStreamResult = {
    text: string;
    thinking?: string;
    finishReason: string;
    refusal?: string;
    structuredValue?: unknown;
};
export interface LlmClient {
    chat(...call: [
        ...CallHead,
        logTiming?: boolean
    ]): Promise<string>;
    stream(...call: [
        ...CallHead,
        onChunk: (text: string) => void,
        logTiming?: boolean
    ]): Promise<string>;
    chatNonStream(...call: [
        ...CallHead,
        reasoningOverride?: ModelSettings["reasoning"],
        options?: NonStreamOptions,
        signal?: AbortSignal
    ]): Promise<NonStreamResult>;
}
function connectionSettings(profile: ModelSettings, thinkingPreference?: ModelSettings["reasoning"]): VendorConfig {
    const { provider, baseUrl, model, apiKey, explicitTransport } = profile;
    return { provider, baseUrl, model, apiKey, explicitTransport, reasoning: thinkingPreference ?? profile.reasoning };
}
function httpFailure(problem: { error?: { message?: string } }, response: Response): Error {
    return new Error(problem.error?.message || `模型请求失败：HTTP ${response.status}`);
}
const firstMessageSize = (transcript: ChatMessage[]): number => transcript[0]?.content?.length ?? 0;
export function createLlmClient(): LlmClient {
    async function stream(
        profile: ModelSettings, transcript: ChatMessage[], samplingTemperature: number | undefined,
        deadlineMs: number, requestLabel: string, consumeText: (text: string) => void, traceTiming = true,
    ): Promise<string> {
        const cancellation = new AbortController();
        const deadline = setTimeout(() => cancellation.abort(), deadlineMs);
        const beganAt = Date.now();
        const duration = (): number => Date.now() - beganAt;
        if (traceTiming) {
            console.log(`[TIMING] ${requestLabel} START timeout=${deadlineMs}ms msgLen=${transcript.length} sysLen=${firstMessageSize(transcript)}`);
        }
        const vendor = connectionSettings(profile);
        try {
            const protocol = getAdapterForConfig(vendor);
            const request = protocol.buildStreamRequest({
                model: vendor.model,
                messages: transcript,
                ...(samplingTemperature !== undefined ? { temperature: samplingTemperature } : {}),
                stream: true,
            }, vendor);
            const reply = await fetch(request.url, {
                method: "POST",
                signal: cancellation.signal,
                headers: request.headers,
                body: request.body,
            });
            if (!reply.ok) {
                const problem = await reply.json().catch(() => ({}));
                throw httpFailure(problem as { error?: { message?: string } }, reply);
            }
            if (!reply.body)
                throw new Error("响应体为空，不支持流式读取");
            recordRequest(profile.model);
            const visibility = createVisibleStreamFilter();
            let rawReply = "";
            let hasMetering = false;
            let inputPeak = 0;
            let outputPeak = 0;
            let cachePeak: number | undefined;
            let cacheWritePeak: number | undefined;
            for await (const frame of createSseReader(protocol, reply.body)) {
                const delta = protocol.parseStreamEvent(frame);
                if (!delta)
                    continue;
                if (delta.deltaText) {
                    rawReply += delta.deltaText;
                    const visibleText = visibility.push(delta.deltaText);
                    if (visibleText)
                        consumeText(visibleText);
                }
                if (delta.usage) {
                    const meter = delta.usage;
                    hasMetering = true;
                    inputPeak = Math.max(inputPeak, meter.input ?? 0);
                    outputPeak = Math.max(outputPeak, meter.output ?? 0);
                    if (meter.cachedInput !== undefined)
                        cachePeak = Math.max(cachePeak ?? 0, meter.cachedInput);
                    if (meter.cacheCreation !== undefined) {
                        cacheWritePeak = Math.max(cacheWritePeak ?? 0, meter.cacheCreation);
                    }
                }
                if (delta.done)
                    break;
            }
            if (hasMetering) {
                recordUsage(inputPeak, outputPeak, 1, cachePeak, profile.model, cacheWritePeak);
            }
            const tail = visibility.flush();
            if (tail)
                consumeText(tail);
            const answer = stripThinkBlocks(rawReply);
            if (traceTiming)
                console.log(`[TIMING] ${requestLabel} OK in ${duration()}ms resultLen=${answer.length}`);
            appendApiLog(requestLabel, transcript, rawReply, answer);
            return answer;
        }
        catch (failure) {
            const timedOut = failure instanceof Error && failure.name === "AbortError";
            if (timedOut) {
                if (traceTiming)
                    console.log(`[TIMING] ${requestLabel} TIMEOUT at ${duration()}ms`);
                throw new Error("模型请求超时，请稍后重试。");
            }
            if (traceTiming) {
                console.log(`[TIMING] ${requestLabel} ERROR at ${duration()}ms: ${failure instanceof Error ? failure.message : failure}`);
            }
            throw failure;
        }
        finally {
            clearTimeout(deadline);
        }
    }
    async function chat(
        profile: ModelSettings, transcript: ChatMessage[], samplingTemperature: number | undefined,
        deadlineMs: number, requestLabel: string, traceTiming = true,
    ): Promise<string> {
        return stream(profile, transcript, samplingTemperature, deadlineMs, requestLabel, () => { }, traceTiming);
    }
    async function chatNonStream(
        profile: ModelSettings, transcript: ChatMessage[], samplingTemperature: number | undefined,
        deadlineMs: number, requestLabel: string, reasoningPreference?: ModelSettings["reasoning"],
        controls?: NonStreamOptions, parentSignal?: AbortSignal,
    ): Promise<NonStreamResult> {
        const vendor = connectionSettings(profile, reasoningPreference);
        const protocol = getAdapterForConfig(vendor);
        const payload = {
            model: vendor.model,
            messages: transcript,
            ...(samplingTemperature !== undefined ? { temperature: samplingTemperature } : {}),
            stream: false,
            ...(controls?.structuredOutput ? { structuredOutput: controls.structuredOutput } : {}),
            ...(controls?.maxTokens !== undefined ? { maxTokens: controls.maxTokens } : {}),
            ...(controls?.extraBody ? { extraBody: controls.extraBody } : {}),
        };
        const cancellation = new AbortController();
        const abortFromParent = (): void => cancellation.abort(parentSignal?.reason);
        parentSignal?.addEventListener("abort", abortFromParent, { once: true });
        const deadline = setTimeout(() => cancellation.abort(), deadlineMs);
        const beganAt = Date.now();
        console.log(`[TIMING] ${requestLabel} START (non-stream) timeout=${deadlineMs}ms msgLen=${transcript.length} sysLen=${firstMessageSize(transcript)}`);
        try {
            const request = protocol.buildRequest(payload, vendor);
            const reply = await fetch(request.url, {
                method: "POST",
                headers: request.headers,
                body: request.body,
                signal: cancellation.signal,
            });
            if (!reply.ok) {
                const problem = await reply.json().catch(() => ({}));
                throw httpFailure(problem as { error?: { message?: string } }, reply);
            }
            const decoded = protocol.parseResponse(await reply.json());
            recordRequest(profile.model);
            if (decoded.usage) {
                recordUsage(decoded.usage.input, decoded.usage.output, 1, decoded.usage.cachedInput, profile.model, decoded.usage.cacheCreation);
            }
            console.log(`[TIMING] ${requestLabel} OK in ${Date.now() - beganAt}ms resultLen=${decoded.text.length}`);
            const { text, thinking, finishReason, refusal, structuredValue } = decoded;
            return { text, thinking, finishReason, refusal, structuredValue };
        }
        catch (failure) {
            const durationMs = Date.now() - beganAt;
            if (failure instanceof Error && failure.name === "AbortError") {
                console.log(`[TIMING] ${requestLabel} TIMEOUT at ${durationMs}ms`);
            }
            else {
                console.log(`[TIMING] ${requestLabel} ERROR at ${durationMs}ms: ${failure}`);
            }
            throw failure;
        }
        finally {
            clearTimeout(deadline);
            parentSignal?.removeEventListener("abort", abortFromParent);
        }
    }
    return { chat, stream, chatNonStream };
}
