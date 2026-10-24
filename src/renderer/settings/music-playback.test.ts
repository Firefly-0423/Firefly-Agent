import { test, expect, vi } from "vitest";
import { requestTrackPlayback as play } from "./music-playback";

test.each([
  ["dispatched", "ok", "已开始播放：Evening signal"],
  ["client_unavailable", "err", "mpv 播放器未就绪"],
  ["launch_failed", "err", "mpv 启动失败"],
] as const)("track dispatch state %s produces the appropriate user feedback", async (state, kind, copy) => {
  const player = vi.fn(async () => ({ ok: true, data: { state, resourceId: "5823", resourceType: "song" } }));
  const feedback = await play({ playTrack: player }, { name: "Evening signal", id: "5823" });
  expect(player.mock.calls).toEqual([["5823"]]);
  expect(feedback.kind).toEqual(kind);
  if (state === "dispatched") expect(feedback).toEqual({ kind, message: copy });
  else expect(feedback.message).toContain(copy);
});

test("backend refusal retains the IPC error identifier", async () => {
  const feedback = await play({ playTrack: vi.fn(async () => ({ ok: false, errorCode: "E_RADIO_OFFLINE" })) }, { name: "Evening signal", id: "5823" });
  expect(feedback).toMatchObject({ kind: "err" });
  expect(feedback.message.includes("E_RADIO_OFFLINE")).toBe(true);
});
