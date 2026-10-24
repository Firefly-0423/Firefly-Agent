import { describe, expect, it, vi } from "vitest";
import { buildMusicTools } from "./music-tools";
import type { QqMusicService } from "../../music/qqmusic-service";

function tools() {
  const service = {
    getState: vi.fn(async () => ({ available: true, playbackStatus: "Paused", title: "歌曲甲" })),
    control: vi.fn(async () => ({
      action: "play",
      target: "QQMusic",
      commandSubmission: "accepted",
      playerStateObservation: "unchanged",
    })),
  };
  return { service, definitions: buildMusicTools(service as unknown as QqMusicService) };
}

describe("QQ Music tools", () => {
  it("registers only a read and permission-gated control", () => {
    const { definitions } = tools();
    expect(definitions.map((tool) => tool.id)).toEqual(["music_get_playback_status", "music_control"]);
    expect(definitions[0]).toMatchObject({ risk: "safe", effectKind: "read" });
    expect(definitions[1]).toMatchObject({ risk: "input-control", effectKind: "external_side_effect", capability: "music.control" });
    expect(definitions.map((tool) => tool.description).join(" ")).not.toContain("网易云");
  });

  it("reads actual desktop state and forwards cancellation", async () => {
    const { service, definitions } = tools();
    const signal = new AbortController().signal;
    const result = await definitions[0].execute({}, { signal } as never);
    expect(JSON.parse(result)).toMatchObject({ available: true, playbackStatus: "Paused" });
    expect(service.getState).toHaveBeenCalledWith(signal);
  });

  it("preserves submitted versus observed state distinction", async () => {
    const { service, definitions } = tools();
    const result = JSON.parse(await definitions[1].execute({ action: "play" }));
    expect(result).toMatchObject({ commandSubmission: "accepted", playerStateObservation: "unchanged" });
    expect(service.control).toHaveBeenCalledWith("play", undefined);
  });

  it("rejects an action outside the actual schema before dispatch", async () => {
    const { service, definitions } = tools();
    await expect(definitions[1].execute({ action: "stop" })).rejects.toThrow("QQ_MUSIC_INVALID_ACTION");
    expect(service.control).not.toHaveBeenCalled();
  });
});
