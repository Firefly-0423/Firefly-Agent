import { encode, getWavFileInfo, isSilk, isWav } from "silk-wasm";

export const WECHAT_VOICE_ENCODE_TYPE_SILK = 6;
export type WechatVoiceSourceFormat = "wav" | "pcm_s16le";
export type EncodeWechatVoiceOptions = { sampleRate?: number; format?: WechatVoiceSourceFormat };
export type EncodedWechatVoice = {
  encodeType: typeof WECHAT_VOICE_ENCODE_TYPE_SILK;
  sampleRate: number;
  durationMs: number;
  data: Buffer;
};

function validateRate(rate: number): void {
  const supported = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);
  if (!Number.isInteger(rate) || !supported.has(rate)) throw new Error(`Unsupported WeChat voice sample rate: ${rate}`);
}
function wavRate(bytes: Uint8Array): number {
  const format = getWavFileInfo(bytes).fmt;
  if (format.formatCode !== 1) throw new Error(`Unsupported WAV format code for WeChat voice: ${format.formatCode}`);
  if (format.numberOfChannels !== 1) throw new Error(`WeChat voice WAV must be mono, got ${format.numberOfChannels} channels`);
  if (format.bitsPerSample !== 16) throw new Error(`WeChat voice WAV must be 16-bit PCM, got ${format.bitsPerSample}-bit`);
  validateRate(format.sampleRate);
  return format.sampleRate;
}

export async function encodeWechatVoiceSilk(input: Buffer | Uint8Array, options: EncodeWechatVoiceOptions = {}): Promise<EncodedWechatVoice> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new Error("WeChat voice input is empty");
  if (isSilk(bytes)) throw new Error("WeChat voice input is already SILK");
  const sourceFormat = options.format ?? (isWav(bytes) ? "wav" : "pcm_s16le");
  let rate: number;
  let encoderRate: number;
  if (sourceFormat === "wav") {
    if (!isWav(bytes)) throw new Error("WeChat voice input is not a WAV file");
    rate = wavRate(bytes);
    encoderRate = 0;
  } else {
    if (typeof options.sampleRate !== "number") throw new Error("WeChat voice PCM input requires sampleRate");
    rate = options.sampleRate;
    validateRate(rate);
    encoderRate = rate;
  }
  const encoded = await encode(bytes, encoderRate);
  if (!encoded.data.length) throw new Error("WeChat voice SILK encoding returned empty data");
  return { data: Buffer.from(encoded.data), durationMs: encoded.duration, sampleRate: rate, encodeType: WECHAT_VOICE_ENCODE_TYPE_SILK };
}
