import { it, expect } from "vitest";
import { isSilk, getDuration } from "silk-wasm";
import { encodeWechatVoiceSilk, WECHAT_VOICE_ENCODE_TYPE_SILK } from "./wechat-voice-encoding";

function pcm(milliseconds: number, rate: number, channels = 1) {
  return Buffer.alloc(rate * milliseconds / 1000 * channels * 2);
}
function wave(milliseconds: number, channels = 1) {
  const bytes = pcm(milliseconds, 24000, channels);
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(bytes.length + 36, 4);
  header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000 * channels, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

it("encodes mono WAV data with duration, rate and protocol encoding metadata", async () => {
  const encoded = await encodeWechatVoiceSilk(wave(80));
  expect(isSilk(encoded.data)).toEqual(true);
  expect(encoded.durationMs).toEqual(80);
  expect(getDuration(encoded.data)).toEqual(80);
  expect(encoded.sampleRate).toEqual(24000);
  expect(encoded.encodeType).toEqual(WECHAT_VOICE_ENCODE_TYPE_SILK);
});

it("accepts raw signed sixteen-bit mono PCM at an explicit sample rate", async () => {
  const encoded = await encodeWechatVoiceSilk(pcm(100, 16000), { sampleRate: 16000, format: "pcm_s16le" });
  expect(isSilk(encoded.data)).toEqual(true);
  expect(encoded.durationMs).toEqual(100);
  expect(encoded.sampleRate).toEqual(16000);
});

it("requires a sample rate for raw PCM", async () => {
  await expect(encodeWechatVoiceSilk(Buffer.from([8, 7, 6, 5]), { format: "pcm_s16le" })).rejects.toThrow("sampleRate");
});

it("refuses stereo WAV input", async () => {
  await expect(encodeWechatVoiceSilk(wave(40, 2))).rejects.toThrow("mono");
});
