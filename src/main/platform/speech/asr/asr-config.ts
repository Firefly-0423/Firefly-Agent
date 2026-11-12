export interface AliyunAsrConfig {
  appKey: string;
  engine: "aliyun";
  language: string;
  accessKeySecret: string;
  accessKeyId: string;
}

export interface MosslandAsrConfig {
  apiKey: string;
  engine: "mossland";
}

export type AsrConfig = AliyunAsrConfig | MosslandAsrConfig;

type ConfigReader = () => AsrConfig | null;
const configSlot: { read: ConfigReader | null } = { read: null };

export function setAsrConfig(getter: () => AsrConfig | null): void {
  configSlot.read = getter;
}

export function getAsrConfig(): AsrConfig | null {
  const read = configSlot.read;
  return read == null ? null : read() ?? null;
}
