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

it("has no duration for missing or empty audio", async () => {
  expect(await getAudioDurationMs(join(directory, "absent.mp3"))).toBeUndefined();
  expect(await getAudioDurationMs(audio("empty.mp3", Buffer.alloc(0)))).toBeUndefined();
});
it("estimates non-MP3 content with a minimum half-second duration", async () => {
  const duration = await getAudioDurationMs(audio("unrecognized.mp3", Buffer.alloc(24_000, 65)));
  expect(duration).toBeDefined();
  expect(duration).toBeGreaterThanOrEqual(500);
});
it("reads a tagged MPEG-1 Layer III stream with a sensible positive duration", async () => {
  const duration = await getAudioDurationMs(audio("tagged.mp3", mpeg(120)));
  expect(duration).toBeDefined();
  expect(duration).toBeGreaterThan(1000);
  expect(duration).toBeLessThan(10_000);
});
it("can estimate the duration of a single frame", async () => {
  const duration = await getAudioDurationMs(audio("single.mp3", mpeg(1)));
  expect(duration).toBeDefined();
  expect(duration).toBeGreaterThanOrEqual(26);
});
