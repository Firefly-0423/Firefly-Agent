/**
 * SDK 侧的 Manifest 纯数据校验。
 *
 * 宿主 src/plugins/manifest-validation.ts 使用同一份自动生成的
 * manifest.schema.json，字段结构、类型、枚举（deps 的能力名单）和必填项都由它约束。
 * Schema 管不到的部分——入口文件是否存在、符号链接是否越界、icon 规则、
 * apiVersion 是否兼容、id 与 SemVer 的格式——仍由宿主加载器的文件系统检查和格式检查负责，
 * 这两层缺一不可。
 */
import Ajv from "ajv";
import manifestSchema from "./manifest.schema.json";
import type { PluginManifestInput } from "./api";

// strict 关闭：Schema 由类型生成器产出，可能带有 Ajv 严格模式不认的关键字
const checkShape = new Ajv({ strict: false }).compile(manifestSchema);

export interface ManifestValidationResult {
  ok: boolean;
  /** 通过校验时返回的纯数据（defaultEnabled 保持可选）。 */
  value?: PluginManifestInput;
  /** 未通过时的首条可读错误，写入扫描日志。 */
  error?: string;
}

export function validateManifestData(data: unknown): ManifestValidationResult {
  if (checkShape(data)) {
    return { ok: true, value: data as PluginManifestInput };
  }
  const issue = (checkShape.errors ?? [])[0];
  const location = issue?.instancePath ? `${issue.instancePath} ` : "";
  const reason = issue?.message ?? "未知错误";
  return { ok: false, error: `manifest 结构不合法: ${location}${reason}` };
}
