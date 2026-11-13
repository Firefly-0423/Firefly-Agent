// 模型输入模态判定：全项目唯一入口 resolveInputModalities（替代原先写死型号的 inferModelMultimodal）。
//
// 优先级（高 → 低）：
//   1. 档案里的显式声明（inputModalities）：用户覆盖 / 厂商接口记录。同一档案只存一份，
//      用户覆盖写入时已替换厂商记录，所以这里不再比较两者；
//   2. 内置目录（vendors/model-modalities.catalog.ts）：只是回落，不是权威；
//   3. 都没有 → 仅文本（保守：宁可让用户手动改成“图片”，也不把图片发给注定 400 的模型）。
//
// 本文件只做加载与匹配，不含任何具体型号；型号数据全部在目录文件里。

import { getCapabilityOrOpenAI } from "./capabilities";
import { MODEL_MODALITY_CATALOG } from "./model-modalities.catalog";
import type { InputModality, InputModalityResolution, InputModalitySource } from "../../../shared/input-modalities";

/** 结果依据与结果类型来自共享模块（主进程与设置页共用同一定义）。 */
export type ResolvedInputModalities = InputModalityResolution;

export interface ResolveInputModalitiesInput {
  provider: string;
  model: string;
  /** 档案里显式声明的输入模态（已清洗）；缺省或空 = 未声明。 */
  declared?: readonly InputModality[];
  declaredSource?: InputModalitySource;
}

interface CompiledCatalogRule {
  vendor?: string;
  pattern: RegExp;
  input: readonly InputModality[];
}

// 目录在加载时编译一次；pattern 写错会在模块加载时直接暴露（单测覆盖）。
const CATALOG: readonly CompiledCatalogRule[] = MODEL_MODALITY_CATALOG.map((entry) => ({
  vendor: entry.vendor,
  pattern: new RegExp(entry.pattern, "i"),
  input: entry.input,
}));

function matchCatalog(vendor: string, name: string): CompiledCatalogRule | undefined {
  // OpenRouter / 网关常用 "厂商/型号" 写法（如 "vendor/model"），规则按裸型号名也能命中。
  const bare = name.slice(name.lastIndexOf("/") + 1);
  return CATALOG.find((rule) =>
    (rule.vendor === undefined || rule.vendor === vendor) && (rule.pattern.test(name) || rule.pattern.test(bare)),
  );
}

/** 厂商 + 型号 + 显式声明 → 主模型能否直发图片，以及依据来自哪里。 */
export function resolveInputModalities(input: ResolveInputModalitiesInput): ResolvedInputModalities {
  if (input.declared && input.declared.length > 0) {
    return {
      image: input.declared.includes("image"),
      source: input.declaredSource === "vendor-api" ? "declared-vendor-api" : "declared-user",
    };
  }
  const name = input.model.trim();
  if (!name) return { image: false, source: "unknown" };
  // 未知厂商按 OpenAI 兼容处理（getCapabilityOrOpenAI），其 id 不会命中任何厂商限定的规则。
  const vendor = getCapabilityOrOpenAI(input.provider).id;
  const rule = matchCatalog(vendor, name);
  if (rule) return { image: rule.input.includes("image"), source: "catalog" };
  return { image: false, source: "unknown" };
}
