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
  /** 自动沿用内置配置，或由用户手动指定。 */
  mode: "auto" | "manual";
  provider: string;
  model: string;
  /** 状态栏上用户可改的显示名；没有填写时界面退回使用 shortName。 */
  displayName?: string;
  /** 去掉括号说明后的厂商简称，作为状态栏文案的备用值。 */
  shortName: string;
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
