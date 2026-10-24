/**
 * manifest 的纯数据校验。
 *
 * 宿主和 SDK 共用同一份生成的 manifest.schema.json，结构、类型、枚举
 * （deps 能力名单）与必填项都由它负责。Schema 管不到的部分——入口文件是否存在、
 * 符号链接越界、icon 规则、apiVersion 兼容、id/SemVer 格式——仍由 loader.ts
 * 的文件系统与格式校验处理，两层缺一不可。
 */
import Ajv from "ajv";
import type { PluginManifestInput } from "./types";
import manifestSchema from "./manifest.schema.json";

const validateSchema = new Ajv({ strict: false }).compile(manifestSchema);

export interface ManifestValidationResult {
  ok: boolean;
  /** 通过校验时的纯数据（defaultEnabled 仍保持可选）。 */
  value?: PluginManifestInput;
  /** 未通过时的第一条可读错误，写入扫描日志。 */
  error?: string;
}

export function validateManifestData(data: unknown): ManifestValidationResult {
  if (validateSchema(data)) return { ok: true, value: data as PluginManifestInput };

  const [issue] = validateSchema.errors ?? [];
  const where = issue?.instancePath ? `${issue.instancePath} ` : "";
  return { ok: false, error: `manifest 结构不合法: ${where}${issue?.message ?? "未知错误"}` };
}
