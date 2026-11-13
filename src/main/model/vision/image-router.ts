// image-router —— 全项目唯一的图片路由。
// 图片能力由显式声明 / 内置目录决定（vendors/multimodal.ts，调用方经 resolveModelSettingsProfile 展开后的 multimodal）；
// 不再有独立的全局视觉模型做转述回退。
//
// 两种路由结果，不允许模糊状态：
// - direct：直发主模型（协议差异交给 transport 适配层，路由层不关心协议）
// - reject：当前型号不能看图，reason 是面向用户的人话提示

/** 图片入口来源，用于日志和针对性提示。 */
export type ImageSource = "attachment" | "tool" | "channel";

/** 路由所需的最小设置视图（完整 ModelSettings 与各处 Lite 型都结构兼容）。 */
export interface ImageRouteSettings {
  /** 主模型能否直发图片（由显式声明 / 内置目录判定）。非 true 一律视为不支持。 */
  multimodal?: boolean;
  explicitTransport?: "openai" | "anthropic" | "responses";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 路由结果：二选一。 */
export type ImageRoute =
  | { mode: "direct" }
  | { mode: "reject"; reason: string };

/** 当前型号不能看图时给用户的人话提示（会话内以 reject 形式告知模型与用户）。 */
export const IMAGE_UNSUPPORTED_REASON =
  "当前模型不支持查看图片。请在「设置 → API 设置」中切换到支持图片的型号（例如 gpt-4o、claude、gemini、qwen-vl、glm-5v 系列）。可在 API 设置 → 该模型 → 高级 → 输入类型 中手动设置。";

/**
 * 统一路由判定。
 * @param source 图片来源
 * @param settings 已展开档案的模型设置（调用方负责 resolveModelSettingsProfile）
 */
export function resolveImageRoute(
  source: ImageSource,
  settings: ImageRouteSettings,
): ImageRoute {
  if (settings.multimodal === true) {
    return { mode: "direct" };
  }
  return { mode: "reject", reason: IMAGE_UNSUPPORTED_REASON };
}

/** 图片转述的视觉端点：成功给出可调配置，失败给出人话错误。 */
export type CaptionVisionConfig =
  | { ok: true; config: { baseUrl: string; apiKey: string; model: string } }
  | { ok: false; error: string };

/**
 * 解析"谁来转述这张图"（read_image / read_image_url 工具、直发失败的 caption 兜底、频道收图共用）：
 * 转述产物是纯文本，必须解析出一个可调的视觉端点。
 *
 * - 不支持图片的型号 → 拒绝
 * - 支持图片 + OpenAI 兼容 → 主模型自己看图（视觉链路只拼 /chat/completions）
 * - 支持图片 + Anthropic → 复用主模型地址必然 404，没有独立视觉模型可用，显式拒绝
 */
export function resolveCaptionVisionConfig(settings: ImageRouteSettings): CaptionVisionConfig {
  const route = resolveImageRoute("tool", settings);
  if (route.mode === "reject") {
    return { ok: false, error: route.reason };
  }
  if (settings.explicitTransport !== "anthropic") {
    return { ok: true, config: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model } };
  }
  return {
    ok: false,
    error:
      "主模型走 Anthropic 协议，图片转述需要 OpenAI 兼容的视觉接口。" +
      "请在「设置 → API 设置」中切换到 OpenAI 兼容或 Responses 协议的多模态型号。",
  };
}
