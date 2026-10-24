import { createHash } from "node:crypto";
import { buildContextUsageSnapshot } from "../context-usage";
import { buildStableSystemPrefix, projectCacheRelevantRequest, type PromptLayers } from "../prompt-layers";
import type { HarnessRun } from "./firefly-harness";

export function emitContextUsage(run: HarnessRun, phase: "preRequest" | "terminal"): void {
  const request = run.input;
  const persona = request.promptLayers?.stablePrefix ?? request.systemPrompt;
  const layers = request.usageParts ?? { personaContent: persona, toolLayerContent: "" };
  request.onEvent?.({ type: "context_usage", snapshot: buildContextUsageSnapshot({
    phase, ...(request.runId ? { runId: request.runId } : {}), round: run.rounds,
    contextWindowTokens: run.config.contextWindowTokens, personaContent: layers.personaContent,
    toolLayerContent: layers.toolLayerContent, ...(layers.skillLayerContent ? { skillLayerContent: layers.skillLayerContent } : {}),
    toolSpecs: run.allToolSpecs, messages: run.messages,
  }) });
}
function fingerprintCacheDiagnostic(value: unknown): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify(value));
  return digest.digest("hex");
}
export function emitCacheDiagnostic(run: HarnessRun, promptLayers: PromptLayers): void {
  if (!run.input.onCacheDiagnostic) return;
  const projection = projectCacheRelevantRequest({ stableSystem: buildStableSystemPrefix(promptLayers), tools: run.allToolSpecs, messages: run.messages });
  run.input.onCacheDiagnostic?.({ ...(run.input.runId ? { runId: run.input.runId } : {}),
    cacheEpoch: run.cache.cacheEpoch, round: run.rounds,
    stablePromptFingerprint: fingerprintCacheDiagnostic(projection.stableSystem), toolSchemaFingerprint: fingerprintCacheDiagnostic(projection.tools),
    messagePrefixFingerprint: fingerprintCacheDiagnostic(projection.messages), messageCount: projection.messages.length,
  });
}
