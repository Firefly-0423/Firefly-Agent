import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ readFile: vi.fn(), rm: vi.fn(), spawn: vi.fn(), detectMpvBinary: vi.fn() }));
vi.mock("node:fs", () => ({ promises: { readFile: deps.readFile, rm: deps.rm } }));
vi.mock("node:child_process", () => ({ spawn: deps.spawn }));
vi.mock("../../../audio/mpv-binary", () => ({ detectMpvBinary: deps.detectMpvBinary }));
import { transcodeAudioFileToFeishuOpus } from "./audio-transcode";
beforeEach(() => { vi.resetAllMocks(); deps.readFile.mockResolvedValue(Buffer.from("OggS")); deps.rm.mockResolvedValue(undefined); deps.detectMpvBinary.mockReturnValue("mpv"); });
afterEach(() => vi.restoreAllMocks());
it("transcodes beside the input to a unique Opus file", async () => {
  const runMpv = vi.fn(async () => {}), input = path.resolve("audio", "hello.wav");
  const output = await transcodeAudioFileToFeishuOpus(input, { resolveMpvBinary: () => "player", runMpv });
  expect(path.dirname(output)).toBe(path.dirname(input));
  expect(path.basename(output)).toMatch(/^hello-[0-9a-f-]{36}\.opus$/);
  expect(runMpv).toHaveBeenCalledWith("player", ["--no-config", "--no-video", "--really-quiet", `--o=${output}`, "--of=opus", "--oac=libopus", "--audio-channels=mono", "--audio-samplerate=48000", input]);
  expect(deps.rm).not.toHaveBeenCalled();
});
it("rejects a missing binary before running or reading", async () => {
  await expect(transcodeAudioFileToFeishuOpus("a.wav", { resolveMpvBinary: () => "" })).rejects.toThrow(/^未找到可用的 mpv，无法将音频转码为飞书 Opus 格式$/);
  expect(deps.spawn).not.toHaveBeenCalled(); expect(deps.readFile).not.toHaveBeenCalled();
});
it.each(["", "Ogg", "RIFFdata"])("removes invalid output %j", async (bytes) => {
  deps.readFile.mockResolvedValue(Buffer.from(bytes));
  await expect(transcodeAudioFileToFeishuOpus("a.wav", { runMpv: async () => {} })).rejects.toThrow(/^mpv 返回的文件不是有效的 Ogg Opus 音频$/);
  expect(deps.rm).toHaveBeenCalledWith(expect.stringMatching(/\.opus$/), { force: true });
});
it("preserves the original runner error even when cleanup fails", async () => {
  const error = new Error("runner failed"); deps.rm.mockRejectedValue(new Error("cleanup failed"));
  await expect(transcodeAudioFileToFeishuOpus("a.wav", { runMpv: async () => { throw error; } })).rejects.toBe(error);
});
it("cleans up unreadable output", async () => {
  const error = new Error("missing output"); deps.readFile.mockRejectedValue(error);
  await expect(transcodeAudioFileToFeishuOpus("a.wav", { runMpv: async () => {} })).rejects.toBe(error);
  expect(deps.rm).toHaveBeenCalledOnce();
});
it.each([0, 2, null])("handles default child process exit %s", async (code) => {
  deps.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    queueMicrotask(() => { child.stderr.emit("data", Buffer.from(" detail \n")); child.emit("close", code); }); return child;
  });
  const promise = transcodeAudioFileToFeishuOpus("a.wav");
  if (code === 0) await expect(promise).resolves.toMatch(/\.opus$/);
  else await expect(promise).rejects.toThrow(`mpv Opus 转码失败（exit=${code}）: detail`);
});
it("propagates a spawn error", async () => {
  const error = new Error("ENOENT");
  deps.spawn.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() }); queueMicrotask(() => child.emit("error", error)); return child; });
  await expect(transcodeAudioFileToFeishuOpus("a.wav")).rejects.toBe(error);
});
it("reports process failure without an empty stderr suffix", async () => {
  deps.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    queueMicrotask(() => child.emit("close", 1)); return child;
  });
  await expect(transcodeAudioFileToFeishuOpus("a.wav")).rejects.toThrow(/^mpv Opus 转码失败（exit=1）$/);
});
