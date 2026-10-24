import { it, describe, expect } from "vitest";
import { firstValueFrom } from "rxjs";
import { FireflyAgent, resolveExecutionMode, type FireflyRunOptions } from "./firefly-agent";

function options(): FireflyRunOptions {
  return { settings: { provider: "unconfigured-calendar-model", model: "", apiKey: "", baseUrl: "", contextWindowTokens: 8_192 },
    executionMode: "chat", messages: [{ role: "user", content: "Open the calendar" }],
    timeoutMs: 900, soulSystemBaseContent: "", toolSystemContent: "",
  };
}
async function start(input: FireflyRunOptions) {
  return await firstValueFrom(new FireflyAgent({ threadId: "agenda-thread" }).runWithEvents(input)) as unknown as { runId: string };
}

describe("Run identity and execution mode admission", () => {
  it.each([[undefined, "work"], ["chat", "chat"], ["work", "work"], ["soul-only", "work"], ["collaboration", "work"]])("resolves the execution mode %s to %s", (requested, expected) => {
    expect(resolveExecutionMode(requested)).toEqual(expected);
  });

  it("generates fresh nonempty string IDs without modifying a reused options object", async () => {
    const input = options();
    expect(input.runId).toBeUndefined();
    const first = await start(input), next = await start(input);
    expect(first.runId).toBeTruthy();
    expect(typeof first.runId).toEqual("string");
    expect(next.runId).toBeTruthy();
    expect(first.runId).not.toBe(next.runId);
    expect(input.runId).toBeUndefined();
  });

  it("preserves an explicitly assigned identity in the event and caller input", async () => {
    const input = { ...options(), runId: "agenda-explicit-run" };
    expect((await start(input)).runId).toEqual("agenda-explicit-run");
    expect(input.runId).toEqual("agenda-explicit-run");
  });
});
