import type { StickerSize } from "./sticker-types";
/** Last explicit connection test in this Main process, not continuous health. */
export interface ModelProfileConnection {
  profileId: string;
  revision: number;
  state: "unverified" | "checking" | "connected" | "failed";
  checkedAt?: number;
  reason?: "test_failed" | "test_error";
  /** Provider, address, model and key are all filled in, so the profile can be used even before anyone tests it. */
  configured?: boolean;
}
export interface ModelConnectionSnapshot {
  defaultProfileId?: string;
  profiles: ModelProfileConnection[];
}
export interface ModelConnectionApi {
  getConnectionSnapshot(): Promise<ModelConnectionSnapshot>;
  onConnectionChanged(callback: (snapshot: ModelConnectionSnapshot) => void): () => void;
}
export interface PublicModelConfig {
  mode: "auto" | "manual";
  provider: string;
  // 用户自定义昵称；留空时状态栏用 shortName
  displayName?: string;
  // 厂商短名（去括号后缀），状态栏"正在喂养"的兜底显示
  shortName: string;
  model: string;
  connected: boolean;
  stickerSize: StickerSize;
  rerankerMode: "standard" | "none";
}

/** Main 的 model:get-install-status 返回的安装状态快照。 */
export interface ModelInstallStatus {
  embedding: { bgem3: boolean };
  reranker: { standard: boolean };
}

export interface ModelConfigApi extends ModelConnectionApi {
  get(): Promise<PublicModelConfig>;
  onChanged(callback: (config: PublicModelConfig) => void): () => void;
  getModelInstallStatus(): Promise<ModelInstallStatus>;
}
