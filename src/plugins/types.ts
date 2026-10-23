import type { PluginManifest } from "./api";

export type PluginSource = "builtin" | "user";

/** 扫描得到的一个已安装插件。 */
export interface PluginRecord {
  source: PluginSource;
  dir: string;
  manifest: PluginManifest;
  /** manifest 与入口文件的 stat 指纹，重扫和重载时用来判断是否变化。 */
  fingerprint: string;
}

export * from "./api";
