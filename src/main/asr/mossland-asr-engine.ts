import { resolveTimeoutPolicy } from "../runtime-policy";
import { raceWithSignal, createAbortError } from "../abort-utils";
import { mosslandFetch, MOSSLAND_BASE_URL, buildMosslandError } from "../mossland/api-client";

/** Build the RIFF fields in protocol order for 16 kHz, 16-bit, single-channel PCM. */
export function encodePcm16MonoWav(pcm: Buffer): Buffer {
  const prefix = Buffer.alloc(44);
  const labels: Array<[string, number]> = [["RIFF", 0], ["WAVE", 8], ["fmt ", 12], ["data", 36]];
  // Use the original write sequence, including its range checks for oversized input.
  prefix.write(labels[0][0], labels[0][1], "ascii");
  prefix.writeUInt32LE(36 + pcm.length, 4);
  for (const [label, offset] of labels.slice(1, 3)) prefix.write(label, offset, "ascii");
  const formatSize = 16;
  prefix.writeUInt32LE(formatSize, 16);
  const sampleWidth = 16;
  const channelCount = 1;
  const frequency = 16_000;
  prefix.writeUInt16LE(1, 20);
  prefix.writeUInt16LE(channelCount, 22);
  prefix.writeUInt32LE(frequency, 24);
  prefix.writeUInt32LE(frequency * channelCount * (sampleWidth / 8), 28);
  prefix.writeUInt16LE(channelCount * (sampleWidth / 8), 32);
  prefix.writeUInt16LE(sampleWidth, 34);
  prefix.write(labels[3][0], labels[3][1], "ascii");
  prefix.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([prefix, pcm]);
}

async function uploadRecording(key: string, recording: Buffer, cancellation: AbortSignal): Promise<string> {
  const multipart = new FormData();
  multipart.append("model", "moss-transcribe");
  multipart.append("response_format", "json");
  multipart.append("file", new Blob([recording], { type: "audio/wav" }), "speech.wav");
  const reply = await mosslandFetch(`${MOSSLAND_BASE_URL}/v1/audio/transcriptions`, {
    method: "POST",
    apiKey: key,
    timeoutMs: resolveTimeoutPolicy({ stage: "asr-mossland" }).totalMs,
    body: multipart,
    signal: cancellation,
  });
  if (!reply.ok) throw buildMosslandError("Mossland 转写失败", reply.status, await reply.text());
  const result = await reply.json() as { text?: unknown };
  if (typeof result.text !== "string") throw new Error("Mossland 转写失败：服务端未返回 text");
  return result.text.trim();
}

export class MosslandAsrStream {
  private readonly audio: Buffer[] = [];
  private completion: Promise<string> | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly apiKey: string,
    private readonly onFinal: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.abort.signal.aborted) throw createAbortError();
    if (!this.apiKey.trim()) throw new Error("Mossland 转写失败：缺少 API Key");
  }

  sendAudio(pcmFrame: Buffer): void {
    if (this.completion || this.abort.signal.aborted || pcmFrame.length === 0) return;
    this.audio.push(Buffer.from(pcmFrame));
  }

  stop(): Promise<string> {
    if (!this.completion) this.completion = this.finishRecording();
    return this.completion;
  }

  cancel(): void {
    this.audio.length = 0;
    this.abort.abort();
  }

  private async finishRecording(): Promise<string> {
    if (this.abort.signal.aborted || this.audio.length === 0) return "";
    const recording = encodePcm16MonoWav(Buffer.concat(this.audio));
    this.audio.length = 0;
    const expiry = new AbortController();
    const alarm = setTimeout(() => expiry.abort(), resolveTimeoutPolicy({ stage: "asr-mossland" }).totalMs);
    const combined = AbortSignal.any([this.abort.signal, expiry.signal]);
    let transcript: string;
    try {
      transcript = await raceWithSignal(uploadRecording(this.apiKey, recording, combined), combined);
    } catch (failure) {
      if (this.abort.signal.aborted) return "";
      if (expiry.signal.aborted) throw new Error("Mossland 转写超时");
      throw failure;
    } finally {
      clearTimeout(alarm);
    }
    if (this.abort.signal.aborted) return "";
    if (transcript) this.onFinal(transcript);
    return transcript;
  }
}
