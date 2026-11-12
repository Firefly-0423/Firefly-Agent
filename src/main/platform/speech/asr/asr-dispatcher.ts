import type { AsrConfig, AliyunAsrConfig } from "./asr-config";
import { AliyunAsrStream } from "./aliyun-asr-engine";
import { MosslandAsrStream } from "./mossland-asr-engine";

export interface AsrStreamSession {
  cancel(): void;
  stop(): Promise<string>;
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
}

type TranscriptListener = (text: string) => void;

function aliyunSession(
  credentials: AliyunAsrConfig,
  partial: TranscriptListener,
  final: TranscriptListener,
): AsrStreamSession {
  const connection = new AliyunAsrStream(partial, final);
  return {
    start: () => {
      // Read at invocation time: settings may change after session creation.
      return connection.start(credentials.appKey, credentials.accessKeyId, credentials.accessKeySecret, credentials.language);
    },
    sendAudio: audio => connection.sendAudio(audio),
    stop: () => connection.stop(),
    cancel: () => connection.cancel(),
  };
}

export function createAsrStream(
  config: AsrConfig,
  onPartial: TranscriptListener,
  onFinal: TranscriptListener,
): AsrStreamSession {
  return config.engine === "mossland"
    ? new MosslandAsrStream(config.apiKey, onFinal)
    : aliyunSession(config, onPartial, onFinal);
}
