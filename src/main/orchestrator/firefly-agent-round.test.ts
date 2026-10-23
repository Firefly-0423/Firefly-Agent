import { describe, expect, it, vi } from "vitest";
import { firstValueFrom } from "rxjs";
import type { UsageAttribution } from "../usage-attribution";

// recordMessage keeps what it saw: the conversation stats only count a round when the run's attribution is already active.
const seen = vi.hoisted(() => ({ message: [] as Array<UsageAttribution | undefined>, plugin: [] as string[] }));
vi.mock("../token-usage-store", async () => {
  const { currentUsageAttribution } = await import("../usage-attribution");
  return {
    recordMessage: () => { seen.message.push(currentUsageAttribution()); },
    recordPluginCall: (id: string) => { seen.plugin.push(id); },
    recordUsage: () => undefined,
    recordRequest: () => undefined,
    recordModelCall: () => undefined,
    recordToolCall: () => undefined,
    recordSkillUse: () => undefined,
    flush: () => undefined,
  };
});

import { FireflyAgent } from "./firefly-agent";
import type { FireflyRunOptions } from "./firefly-agent";

function options(overrides: Partial<FireflyRunOptions> = {}): FireflyRunOptions {
  return {
    // An invalid provider fails after RUN_STARTED, which is all these tests need.
    settings: { provider: "invalid-provider", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 4096 },
    messages: [{ role: "user", content: "hi" }],
    executionMode: "chat",
    timeoutMs: 1000,
    toolSystemContent: "",
    soulSystemBaseContent: "",
    ...overrides,
  } as FireflyRunOptions;
}

async function startRun(runOptions: FireflyRunOptions, threadId = "thread"): Promise<void> {
  await firstValueFrom(new FireflyAgent({ threadId }).runWithEvents(runOptions));
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("a run counts one round for its own conversation", () => {
  it("records the round inside the run's attribution, so it lands on the conversation and its mode", async () => {
    seen.message.length = 0;
    await startRun(options({ conversationId: "session-a", conversationMode: "code" }));
    expect(seen.message).toEqual([expect.objectContaining({ feature: "code", sessionId: "session-a" })]);
  });

  it("counts a plugin run as a plugin call, not as a conversation round", async () => {
    seen.message.length = 0;
    seen.plugin.length = 0;
    await startRun(options({ conversationId: "plugin:minecraft" }));
    expect(seen.plugin).toEqual(["minecraft"]);
    expect(seen.message).toEqual([]);
  });
});
