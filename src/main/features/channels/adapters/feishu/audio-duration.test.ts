import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAudioDurationMs } from "./audio-duration";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "feishu-duration-contract-"));
  vi.stubEnv("FIREFLY_SKIP_FFPROBE", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function audio(name: string, bytes: Buffer) {
  const file = join(directory, name);
  writeFileSync(file, bytes);
  return file;
}
function mpeg(frames: number): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([255, 251, 144, 0]);
  const tag = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([tag, ...Array.from({ length: frames }, () => frame)]);
}

it("has no duration for missing, empty, or at-most-1024-byte non-MP3 audio", async () => {
  expect(await getAudioDurationMs(join(directory, "absent.mp3"))).toBeUndefined();
  expect(await getAudioDurationMs(audio("empty.mp3", Buffer.alloc(0)))).toBeUndefined();
  // estimateByFileSize returns undefined when size <= 1024 bytes.
  expect(await getAudioDurationMs(audio("small.mp3", Buffer.alloc(1024, 65)))).toBeUndefined();
});
it("estimates non-MP3 content with a 500ms floor above 1024 bytes", async () => {
  // estimateByFileSize (size > 1024): Math.max(500, Math.round(size / 16000 * 1000))
  expect(await getAudioDurationMs(audio("just-over.mp3", Buffer.alloc(1025, 65)))).toBe(500);
  expect(await getAudioDurationMs(audio("short.mp3", Buffer.alloc(2000, 65)))).toBe(500);
  expect(await getAudioDurationMs(audio("floor-edge.mp3", Buffer.alloc(7991, 65)))).toBe(500);
  expect(await getAudioDurationMs(audio("above-floor.mp3", Buffer.alloc(8009, 65)))).toBe(501);
  expect(await getAudioDurationMs(audio("unrecognized.mp3", Buffer.alloc(24_000, 65)))).toBe(1500);
});
it("reads a tagged MPEG-1 Layer III stream with exact duration", async () => {
  // MPEG-1 Layer III 44.1kHz: Math.round(120 * 1152 / 44100 * 1000) = 3135
  expect(await getAudioDurationMs(audio("tagged.mp3", mpeg(120)))).toBe(3135);
});
it("computes the exact duration of a single frame", async () => {
  // MPEG-1 Layer III 44.1kHz: Math.round(1 * 1152 / 44100 * 1000) = 26
  expect(await getAudioDurationMs(audio("single.mp3", mpeg(1)))).toBe(26);
});
