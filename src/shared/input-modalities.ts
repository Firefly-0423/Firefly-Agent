// 模型输入模态（文本 / 图片）的共享类型与清洗。
//
// 档案里的显式声明（inputModalities）只有两种来源：
//   - vendor-api：从厂商接口的模型清单里读到的（OpenRouter / Anthropic / 各网关的能力字段）；
//   - user：用户在 API 设置里手动覆盖（图片 / 仅文本）。
// 同一档案只存一份声明；用户覆盖写入时会替换厂商接口记录。
// 生效结果（能不能直发图片）只由主进程 resolveInputModalities 给出，见 src/main/orchestrator/vendors/multimodal.ts。

export const INPUT_MODALITIES = ["text", "image"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

export const INPUT_MODALITY_SOURCES = ["vendor-api", "user"] as const;
export type InputModalitySource = (typeof INPUT_MODALITY_SOURCES)[number];

/** 生效结果的依据：显式声明（区分用户覆盖 / 厂商接口记录）、内置目录，或都不认识。 */
export type InputModalityResolutionSource = "declared-user" | "declared-vendor-api" | "catalog" | "unknown";

/** 生效结果：主模型能否直发图片，以及依据来自哪里（界面用于说明“为什么”）。 */
export interface InputModalityResolution {
  image: boolean;
  source: InputModalityResolutionSource;
}

/** 收敛成规范的模态列表（去重、固定顺序）；不含任何合法模态 → undefined（即未声明）。 */
export function normalizeInputModalities(input: unknown): InputModality[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const wanted = new Set<unknown>(input);
  const modalities = INPUT_MODALITIES.filter((modality) => wanted.has(modality));
  return modalities.length > 0 ? [...modalities] : undefined;
}

export function normalizeInputModalitiesSource(input: unknown): InputModalitySource | undefined {
  return INPUT_MODALITY_SOURCES.find((source) => source === input);
}

/**
 * 声明成对清洗：模态非法 → 两个字段都不返回（= 未声明，回退内置目录）；
 * 模态合法但来源缺失或非法 → 记为 user（无可靠来源的声明按用户自己的设置对待）。
 */
export function normalizeDeclaredInputModalities(
  modalities: unknown,
  source: unknown,
): { inputModalities?: InputModality[]; inputModalitiesSource?: InputModalitySource } {
  const inputModalities = normalizeInputModalities(modalities);
  if (!inputModalities) return {};
  return { inputModalities, inputModalitiesSource: normalizeInputModalitiesSource(source) ?? "user" };
}
