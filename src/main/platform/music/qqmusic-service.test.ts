import { describe, expect, it, vi } from "vitest";
import { QqMusicService, type QqMusicExecutor, type QqMusicRawResult } from "./qqmusic-service";

const playing = (overrides: Partial<QqMusicRawResult> = {}): QqMusicRawResult => ({
  ok: true,
  found: true,
  appId: "QQMusic.exe",
  title: "歌曲甲",
  artist: "歌手甲",
  playbackStatus: "Playing",
  canPlay: true,
  canPause: true,
  canNext: true,
  canPrev: true,
  ...overrides,
});

describe("QQ Music desktop bridge", () => {
  it("reports only the exact QQMusic.exe session", async () => {
    const executor = vi.fn(async () => playing({ appId: "OtherMusic.exe" }));
    const service = new QqMusicService(executor);
    expect(await service.getState()).toEqual({ available: false, errorCode: "QQ_MUSIC_WRONG_PLAYER" });
    expect((await service.control("play")).commandSubmission).toBe("not_submitted");
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("distinguishes absent session and bridge failure", async () => {
    const absent = new QqMusicService(async () => ({ ok: true, found: false }));
    expect(await absent.getState()).toEqual({ available: false, errorCode: "QQ_MUSIC_SESSION_NOT_FOUND" });
    const failed = new QqMusicService(async () => ({ ok: false, error: "QQ_MUSIC_BRIDGE_FAILED" }));
    expect((await failed.getState()).errorCode).toBe("QQ_MUSIC_BRIDGE_FAILED");
  });

  it("observes a real playback state change after an accepted command", async () => {
    const executor = vi.fn<QqMusicExecutor>()
      .mockResolvedValueOnce(playing({ playbackStatus: "Paused" }))
      .mockResolvedValueOnce({ ok: true, found: true, appId: "QQMusic.exe", action: "play" })
      .mockResolvedValueOnce(playing());
    const service = new QqMusicService(executor, 0);
    expect(await service.control("play")).toMatchObject({
      commandSubmission: "accepted",
      playerStateObservation: "changed",
      observedState: { available: true, playbackStatus: "Playing" },
    });
    expect(executor.mock.calls.map(([action]) => action)).toEqual(["get-state", "play", "get-state"]);
  });

  it("does not present accepted command as a confirmed state change", async () => {
    const executor = vi.fn<QqMusicExecutor>()
      .mockResolvedValueOnce(playing())
      .mockResolvedValueOnce({ ok: true, found: true, appId: "QQMusic.exe", action: "next" })
      .mockResolvedValueOnce(playing());
    expect(await new QqMusicService(executor, 0).control("next")).toMatchObject({
      commandSubmission: "accepted", playerStateObservation: "unchanged",
    });
  });

  it("maps previous to the existing prev script action and observes the track", async () => {
    const executor = vi.fn<QqMusicExecutor>()
      .mockResolvedValueOnce(playing())
      .mockResolvedValueOnce({ ok: true, found: true, appId: "QQMusic.exe", action: "prev" })
      .mockResolvedValueOnce(playing({ title: "歌曲乙" }));
    expect(await new QqMusicService(executor, 0).control("previous")).toMatchObject({
      commandSubmission: "accepted", playerStateObservation: "changed",
    });
    expect(executor.mock.calls[1][0]).toBe("prev");
  });

  it("does not submit unavailable controls", async () => {
    const executor = vi.fn(async () => playing({ canNext: false }));
    expect(await new QqMusicService(executor).control("next")).toMatchObject({
      commandSubmission: "not_submitted", errorCode: "QQ_MUSIC_CONTROL_UNAVAILABLE",
    });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("reports rejected commands and observation failures separately", async () => {
    const rejected = vi.fn<QqMusicExecutor>()
      .mockResolvedValueOnce(playing())
      .mockResolvedValueOnce({ ok: false, found: true, appId: "QQMusic.exe", action: "pause" });
    expect(await new QqMusicService(rejected, 0).control("pause")).toMatchObject({
      commandSubmission: "rejected", playerStateObservation: "not_observed",
    });
    const lost = vi.fn<QqMusicExecutor>()
      .mockResolvedValueOnce(playing())
      .mockResolvedValueOnce({ ok: true, found: true, appId: "QQMusic.exe", action: "pause" })
      .mockResolvedValueOnce({ ok: false, error: "QQ_MUSIC_BRIDGE_FAILED" });
    expect(await new QqMusicService(lost, 0).control("pause")).toMatchObject({
      commandSubmission: "accepted", playerStateObservation: "failed",
    });
  });

  it("cancels before dispatch and marks interruption during dispatch as unknown", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = vi.fn(async () => playing());
    expect(await new QqMusicService(executor).control("play", controller.signal)).toMatchObject({
      commandSubmission: "not_submitted", errorCode: "CANCELLED",
    });
    expect(executor).not.toHaveBeenCalled();

    const during = new AbortController();
    const interrupted = vi.fn<QqMusicExecutor>()
      .mockResolvedValueOnce(playing())
      .mockImplementationOnce(async () => {
        during.abort();
        return { ok: false, error: "CANCELLED" };
      });
    expect(await new QqMusicService(interrupted, 0).control("play", during.signal)).toMatchObject({
      commandSubmission: "unknown", errorCode: "CANCELLED_DURING_SUBMISSION",
    });
  });
});
