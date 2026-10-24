import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialContextSchedulerDeps } from "../../social-context/scheduler";
import type { SocialExtractionInput } from "../../social-context/types";
import type { StructuredOutputProfile, StructuredOutputMode } from "../../orchestrator/structured-output/types";
import type { ModelSettings } from "../../settings/model-settings";

const state = vi.hoisted(() => ({
  userData: "C:/firefly-user-data",
  settings: {} as Record<string, unknown>,
  profile: {} as Record<string, unknown>,
  endpointKind: "official",
  classifyInput: undefined as unknown,
  adapter: {
    id: "chatgpt",
    transport: "openai",
    capability: { baseUrl: "https://api.openai.com/v1" },
  },
  schedulerDeps: undefined as SocialContextSchedulerDeps | undefined,
  storeFile: "",
  chatResponse: {} as Record<string, unknown>,
  chatError: undefined as Error | undefined,
  enqueueResult: "enqueued" as unknown,
}));

vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));

vi.mock("../../settings/model-settings", () => ({
  loadModelSettings: () => state.settings,
}));

vi.mock("../../orchestrator/vendors", () => ({
  getAdapterForConfig: () => state.adapter,
}));

vi.mock("../../orchestrator/structured-output/profiles", () => ({
  resolveStructuredOutputProfile: () => state.profile,
  classifyStructuredOutputEndpoint: (input: unknown) => {
    state.classifyInput = input;
    return "official";
  },
}));

vi.mock("../../social-context/scheduler", () => ({
  createSocialContextScheduler: (deps: SocialContextSchedulerDeps) => {
    state.schedulerDeps = deps;
    return { schedule: vi.fn() };
  },
}));

vi.mock("../../social-context/store", () => ({
  createSocialAtomStore: (file: string) => {
    state.storeFile = file;
    return { sentinel: true };
  },
}));

import { SOCIAL_EXTRACTION_SCHEMA } from "../../social-context/extractor";
import { createSocialContextService } from "./social-context-service";

const chatNonStream = vi.fn();

function settings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    provider: "chatgpt",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-6",
    apiKey: "key",
    explicitTransport: "openai",
    ...overrides,
  } as ModelSettings;
}

function profile(mode: StructuredOutputMode, hints: { sendJsonObject: boolean; reasoningSplit: boolean } = {
  sendJsonObject: false,
  reasoningSplit: false,
}): StructuredOutputProfile {
  return { mode, requestHints: hints } as StructuredOutputProfile;
}

function input(): SocialExtractionInput {
  return {
    conversationId: "conversation-1",
    userTurn: { id: "user-1", role: "user", text: "我住在上海" },
    assistantTurn: { id: "assistant-1", role: "assistant", text: "上海是个好地方" },
    retrievedAtoms: [],
    now: 1_700_000_000_000,
  };
}

function service() {
  return createSocialContextService({
    llmClient: { chatNonStream } as never,
    enqueueLLMTask: vi.fn(async () => state.enqueueResult),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  state.settings = settings();
  state.profile = profile("provider_json_schema");
  state.endpointKind = "official";
  state.schedulerDeps = undefined;
  state.storeFile = "";
  state.chatResponse = { text: "{\"operations\":[]}", finishReason: "stop" };
  state.chatError = undefined;
  state.enqueueResult = "enqueued";
  chatNonStream.mockReset();
  chatNonStream.mockImplementation(async () => {
    if (state.chatError) throw state.chatError;
    return state.chatResponse;
  });
});

describe("createSocialContextService", () => {
  it("creates the atom store under user data and returns the scheduler", () => {
    const result = service();
    expect(state.storeFile).toBe(path.join("C:/firefly-user-data", "chat-social-atoms.json"));
    expect(result.store).toEqual({ sentinel: true });
    expect(result.scheduler).toEqual({ schedule: expect.any(Function) });
  });

  it("classifies the configured endpoint against the adapter capability", async () => {
    service();
    const generate = state.schedulerDeps!.generate;
    await generate(input());
    expect(state.classifyInput).toEqual({
      providerId: "chatgpt",
      configuredBaseUrl: "https://api.openai.com/v1",
      officialBaseUrl: "https://api.openai.com/v1",
    });
  });

  it("requests provider JSON schema output and returns the model text", async () => {
    state.profile = profile("provider_json_schema");
    service();
    const generate = state.schedulerDeps!.generate;

    await expect(generate(input())).resolves.toBe("{\"operations\":[]}");

    const args = chatNonStream.mock.calls[0];
    expect(args[0]).toBe(state.settings);
    expect(args[1]).toHaveLength(2);
    expect(args[1][0].role).toBe("system");
    expect(args[1][0].content).toContain("Extract only directly supported chat continuity facts");
    expect(args[1][1].role).toBe("user");
    expect(args[1][1].content).toContain("我住在上海");
    expect(args[2]).toBe(0);
    expect(args[3]).toBe(12_000);
    expect(args[4]).toBe("Chat social context extraction");
    expect(args[5]).toEqual({ mode: "off" });
    expect(args[6]).toEqual({
      structuredOutput: {
        mode: "json_schema",
        name: "chat_social_atoms",
        schema: SOCIAL_EXTRACTION_SCHEMA,
        strict: true,
      },
      maxTokens: 1_000,
    });
  });

  it("uses JSON object output for provider_json_object", async () => {
    state.profile = profile("provider_json_object");
    service();
    await state.schedulerDeps!.generate(input());
    expect(chatNonStream.mock.calls[0][6].structuredOutput).toEqual({
      mode: "json_object",
      name: "chat_social_atoms",
      schema: SOCIAL_EXTRACTION_SCHEMA,
    });
    expect(chatNonStream.mock.calls[0][6]).not.toHaveProperty("extraBody");
  });

  it("uses prompt JSON output and forwards the request hints", async () => {
    state.profile = profile("prompt_json", { sendJsonObject: true, reasoningSplit: true });
    service();
    await state.schedulerDeps!.generate(input());
    expect(chatNonStream.mock.calls[0][6]).toEqual({
      structuredOutput: {
        mode: "prompt_json",
        name: "chat_social_atoms",
        schema: SOCIAL_EXTRACTION_SCHEMA,
        sendJsonObjectHint: true,
      },
      maxTokens: 1_000,
      extraBody: { reasoning_split: true },
    });
  });

  it("omits the prompt JSON hint when the profile does not request it", async () => {
    state.profile = profile("prompt_json", { sendJsonObject: false, reasoningSplit: false });
    service();
    await state.schedulerDeps!.generate(input());
    expect(chatNonStream.mock.calls[0][6]).toEqual({
      structuredOutput: {
        mode: "prompt_json",
        name: "chat_social_atoms",
        schema: SOCIAL_EXTRACTION_SCHEMA,
        sendJsonObjectHint: false,
      },
      maxTokens: 1_000,
    });
  });

  it("asks for temperature 0 except for kimi-k2.6 models", async () => {
    state.settings = settings({ model: "gpt-6" });
    service();
    await state.schedulerDeps!.generate(input());
    expect(chatNonStream.mock.calls[0][2]).toBe(0);

    state.settings = settings({ provider: "kimi", model: "kimi-k2.6", baseUrl: "https://api.kimi.com/coding/v1" });
    service();
    await state.schedulerDeps!.generate(input());
    expect(chatNonStream.mock.calls[1][2]).toBeUndefined();

    state.settings = settings({ provider: "kimi", model: "kimi-k2.6-highspeed" });
    service();
    await state.schedulerDeps!.generate(input());
    expect(chatNonStream.mock.calls[2][2]).toBeUndefined();
  });

  it("includes the repair context in the user prompt when supplied", async () => {
    service();
    await state.schedulerDeps!.generate(input(), {
      attempt: 1,
      previousOutput: "BAD OUTPUT",
      rejectedCount: 2,
    });
    const prompt = chatNonStream.mock.calls[0][1][1].content as string;
    expect(prompt).toContain("第 1 次修复");
    expect(prompt).toContain("拒绝了 2 条");
    expect(prompt).toContain("BAD OUTPUT");
  });

  it.each([
    ["a refusal", { text: "x", finishReason: "stop", refusal: "declined" }],
    ["a truncated finish", { text: "x", finishReason: "length" }],
    ["an unknown finish", { text: "x", finishReason: "something-else" }],
    ["a missing finish", { text: "x" }],
  ])("rejects %s", async (_label, response) => {
    service();
    state.chatResponse = response as Record<string, unknown>;
    await expect(state.schedulerDeps!.generate(input())).rejects.toThrow("CHAT_SOCIAL_EXTRACTION_INCOMPLETE");
  });

  it("accepts every complete finish reason", async () => {
    service();
    for (const finishReason of ["stop", "end_turn", "stop_sequence"]) {
      state.chatResponse = { text: `text-${finishReason}`, finishReason };
      await expect(state.schedulerDeps!.generate(input())).resolves.toBe(`text-${finishReason}`);
    }
  });

  it("forwards enqueue options without logging or rate-limit retries", async () => {
    const enqueueLLMTask = vi.fn(async () => state.enqueueResult);
    createSocialContextService({
      llmClient: { chatNonStream } as never,
      enqueueLLMTask,
    });
    const task = vi.fn(async () => {});

    await expect(state.schedulerDeps!.enqueue("label", task)).resolves.toBe("enqueued");
    expect(enqueueLLMTask).toHaveBeenCalledWith("label", task, { log: false, retryRateLimit: false });
  });

  it("records a sanitized one-line metric", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    service();
    state.schedulerDeps!.recordMetric?.({
      outcome: "failure",
      acceptedCount: 1,
      rejectedCount: 2,
      attempts: 3,
      repairCount: 2,
    });
    expect(log).toHaveBeenCalledWith(
      "[ChatSocialContext] outcome=failure accepted=1 rejected=2 attempts=3 repairs=2",
    );
  });
});
