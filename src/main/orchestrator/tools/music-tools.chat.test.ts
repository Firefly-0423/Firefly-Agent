import { describe, expect, it, vi } from "vitest";
import { QqMusicService } from "../../music/qqmusic-service";
import { policyFor } from "../../permission-policy";
import { resolveRunCapabilities } from "../run-capabilities";
import { buildMusicTools } from "./music-tools";
import { ToolRegistry, type ToolModeOverrides } from "./registry/tool-registry";

// The registry's unrelated RAG dependency opens local storage; these tests do
// not execute memory tools and keep that external boundary out of the fixture.
vi.mock("../../rag/index", () => ({ searchMemory: vi.fn() }));

const musicIds = ["music_get_playback_status", "music_control"];

function fixture() {
  let title = "Track A";
  const service = new QqMusicService(async action => {
    if (action === "next") title = "Track B";
    return { ok: true, found: true, appId: "QQMusic.exe", action, title, playbackStatus: "Playing", canNext: true };
  }, 0);
  const registry = new ToolRegistry();
  for (const tool of buildMusicTools(service)) registry.register(tool);
  return registry;
}

function chatCapabilities(registry: ToolRegistry, enabled: boolean, overrides?: ToolModeOverrides) {
  return resolveRunCapabilities({
    mode: "chat", chatToolsEnabled: enabled, toolModeOverrides: overrides,
    activeSearchBackend: "off", toolRegistry: registry,
    skillRegistry: { getEnabledForMode: () => [] },
  });
}

describe("QQ Music in Chat", () => {
  it("recommends the existing two tools for Chat and Work while excluding Code", () => {
    const registry = fixture();
    expect(registry.getEnabledToolsForMode("chat").map(tool => tool.id)).toEqual(musicIds);
    expect(registry.getEnabledToolsForMode("work").map(tool => tool.id)).toEqual(musicIds);
    expect(registry.getEnabledToolsForMode("code")).toEqual([]);
  });

  it("requires Chat enhancement and explicit opt-in and honors opt-out", () => {
    const registry = fixture();
    const selected = { music_get_playback_status: { chat: true }, music_control: { chat: true } };
    expect([...chatCapabilities(registry, false, selected).toolIds]).toEqual([]);
    expect([...chatCapabilities(registry, true).toolIds]).toEqual([]);
    expect([...chatCapabilities(registry, true, selected).toolIds]).toEqual(musicIds);
    expect([...chatCapabilities(registry, true, { ...selected, music_control: { chat: false } }).toolIds])
      .toEqual(["music_get_playback_status"]);
  });

  it("retains existing input-control permission decisions", () => {
    const control = fixture().getById("music_control")!;
    expect(control.chatBuiltin).not.toBe(true);
    expect(control.effectKind).toBe("external_side_effect");
    expect(control.risk).toBe("input-control");
    expect(policyFor("read-only", control.risk!)).toBe("deny");
    expect(policyFor("scoped", control.risk!)).toBe("deny");
    expect(policyFor("per-action", control.risk!)).toBe("ask");
    expect(policyFor("full", control.risk!)).toBe("allow");
  });

  it("runs next through the existing service with submitted and observed results", async () => {
    const registry = fixture();
    const control = chatCapabilities(registry, true, { music_control: { chat: true } }).tools[0];
    const result = JSON.parse(await control.execute({ action: "next" }));
    expect(result).toMatchObject({
      action: "next", target: "QQMusic", commandSubmission: "accepted", playerStateObservation: "changed",
      observedState: { available: true, title: "Track B" },
    });
  });
});
