import path from "node:path";
import { app } from "electron";
import { loadModelSettings } from "../../settings/model-settings";
import type { ModelSettings } from "../../settings/model-settings";
import { getAdapterForConfig } from "../../orchestrator/vendors";
import type { StructuredOutputRequest, VendorConfig } from "../../orchestrator/vendors";
import * as structuredProfiles from "../../orchestrator/structured-output/profiles";
import { normalizeFinishReason } from "../../orchestrator/structured-output/finish-reason";
import { buildSocialExtractionPrompt, SOCIAL_EXTRACTION_SCHEMA } from "../../social-context/extractor";
import { createSocialContextScheduler } from "../../social-context/scheduler";
import { createSocialAtomStore } from "../../social-context/store";
import type { LlmClient } from "../llm/llm-client";

type AtomStore = ReturnType<typeof createSocialAtomStore>;
type ContextScheduler = ReturnType<typeof createSocialContextScheduler>;

export type SocialContextService = {
  store: AtomStore;
  scheduler: ContextScheduler;
};

type EnqueueOptions = { log: boolean; retryRateLimit: boolean };

export type SocialContextServiceDeps = {
  enqueueLLMTask: (label: string, task: () => Promise<void>, options: EnqueueOptions) => Promise<unknown>;
  llmClient: LlmClient;
};

const SCHEMA_NAME = "chat_social_atoms";
const EXTRACTION_LABEL = "Chat social context extraction";
const SYSTEM_RULE =
  "Extract only directly supported chat continuity facts. Return exactly one JSON object and no prose.";

type OutputProfile = ReturnType<typeof structuredProfiles.resolveStructuredOutputProfile>;

/** 抽取任务不需要推理，推理模式固定关闭 */
function extractionVendorConfig(settings: ModelSettings): VendorConfig {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: { mode: "off" },
  };
}

function profileFor(config: VendorConfig, adapter: ReturnType<typeof getAdapterForConfig>): OutputProfile {
  const endpointKind = structuredProfiles.classifyStructuredOutputEndpoint({
    providerId: adapter.id,
    configuredBaseUrl: config.baseUrl,
    officialBaseUrl: adapter.capability.baseUrl,
  });
  return structuredProfiles.resolveStructuredOutputProfile({
    provider: adapter.id,
    model: config.model,
    transport: adapter.transport,
    endpointKind,
  });
}

function structuredOutputFor(profile: OutputProfile): StructuredOutputRequest {
  const base = { name: SCHEMA_NAME, schema: SOCIAL_EXTRACTION_SCHEMA };
  switch (profile.mode) {
    case "provider_json_schema":
      return { mode: "json_schema", ...base, strict: true };
    case "provider_json_object":
      return { mode: "json_object", ...base };
    default:
      return { mode: "prompt_json", ...base, sendJsonObjectHint: profile.requestHints.sendJsonObject };
  }
}

export function createSocialContextService(deps: SocialContextServiceDeps): SocialContextService {
  const storeFile = path.join(app.getPath("userData"), "chat-social-atoms.json");
  const store = createSocialAtomStore(storeFile);

  const scheduler = createSocialContextScheduler({
    store,
    enqueue: (label, task) => deps.enqueueLLMTask(label, task, { log: false, retryRateLimit: false }),
    generate: async (input, repair) => {
      const settings = loadModelSettings();
      const config = extractionVendorConfig(settings);
      const profile = profileFor(config, getAdapterForConfig(config));

      // kimi-k2.6 系列不接受自定义 temperature
      const isKimiK26 = /^kimi-k2\.6(?:$|-)/i.test(settings.model);

      const reply = await deps.llmClient.chatNonStream(
        settings,
        [
          { role: "system", content: SYSTEM_RULE },
          { role: "user", content: buildSocialExtractionPrompt(input, repair) },
        ],
        isKimiK26 ? undefined : 0,
        12_000,
        EXTRACTION_LABEL,
        { mode: "off" },
        {
          structuredOutput: structuredOutputFor(profile),
          maxTokens: 1_000,
          ...(profile.requestHints.reasoningSplit ? { extraBody: { reasoning_split: true } } : {}),
        },
      );

      if (reply.refusal || normalizeFinishReason(reply.finishReason) !== "complete") {
        throw new Error("CHAT_SOCIAL_EXTRACTION_INCOMPLETE");
      }
      return reply.text;
    },
    recordMetric: ({ outcome, acceptedCount, rejectedCount, attempts, repairCount }) => {
      console.log(
        `[ChatSocialContext] outcome=${outcome} accepted=${acceptedCount} rejected=${rejectedCount} attempts=${attempts} repairs=${repairCount}`,
      );
    },
  });

  return { store, scheduler };
}
