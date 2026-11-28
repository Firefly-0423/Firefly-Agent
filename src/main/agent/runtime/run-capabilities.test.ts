import { it, expect, describe } from "vitest";
import { resolveRunCapabilities } from "./run-capabilities";

describe("Capabilities admitted to a conversation", () => {
  type Mode = "chat" | "work" | "code";
  function request(mode: Mode, overrides: Record<string, Partial<Record<Mode, boolean>>> = {}, chatToolsEnabled = false) {
    const inventory = [
      { id: "read_file" }, { id: "git_commit", modes: ["code"] }, { id: "web_search" }, { id: "weather" },
      { id: "persona_read", modes: ["chat"], chatBuiltin: true }, { id: "persona_write", modes: ["chat"], chatBuiltin: true },
    ];
    return resolveRunCapabilities({ mode, chatToolsEnabled, activeSearchBackend: "off", toolModeOverrides: overrides,
      toolRegistry: { getEnabledToolsForMode: (target) => inventory.filter((entry) => overrides[entry.id]?.[target] ?? (!entry.modes || entry.modes.includes(target))) as any },
      skillRegistry: { getEnabledForMode: (target) => (target === "work" ? [{ id: "calendar" }, { id: "documents" }] : [{ id: "review" }]) as any },
    });
  }

  it.each([false, true])("keeps ordinary tools opt-in even with enhancement set to %s", (enhancement) => {
    const capabilities = request("chat", {}, enhancement);
    expect(Array.from(capabilities.toolIds)).toEqual(["persona_read", "persona_write"]);
    expect(capabilities.skills).toStrictEqual([]);
  });

  it("places builtins before opt-ins, deduplicates them, and allows explicit disabling", () => {
    const opted = request("chat", { persona_read: { chat: true }, weather: { chat: true }, read_file: { chat: false } }, true);
    expect([...opted.toolIds]).toEqual(["persona_read", "persona_write", "weather"]);
    expect(opted.tools.filter(({ id }) => id === "persona_read")).toHaveLength(1);
    expect(opted.skills).toEqual([]);
    expect([...request("chat", { persona_write: { chat: false } }).toolIds]).toEqual(["persona_read"]);
  });

  it("honors work and code visibility and rejects an unknown conversation mode", () => {
    const work = request("work");
    expect(work.toolIds).not.toContain("git_commit");
    expect(work.toolIds).not.toContain("persona_read");
    expect(request("code").toolIds).toContain("git_commit");
    expect(work.skillIds).toEqual(new Set(["calendar", "documents"]));
    expect(() => request("unsupported" as Mode)).toThrow("INVALID_CONVERSATION_MODE");
  });
});
