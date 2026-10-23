import type { PluginPromptBuildInput, PluginPromptProvider, PluginPromptSource } from "./types";

const PROMPT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS = 2_000;
export const MAX_PLUGIN_PROMPT_CHARS = 16_000;
export const MAX_PLUGIN_PROMPT_TOTAL_CHARS = 32_000;

/** 没声明 sources 的 Provider 只参与旧有场景，保持向后兼容。 */
const LEGACY_PROMPT_SOURCES: readonly PluginPromptSource[] = ["conversation", "scheduler"];

const KNOWN_MODES = ["chat", "work", "code"];
const KNOWN_SOURCES = ["conversation", "scheduler", "plugin-agent"];

type PromptEntry = {
  signal: AbortSignal;
  provider: PluginPromptProvider;
  ownerId: string;
};

export type PluginPromptRegistry = {
  clear(): void;
  build(input: PluginPromptBuildInput): Promise<string>;
  unregister(ownerId: string, providerId: string): boolean;
  register(ownerId: string, provider: PluginPromptProvider, signal: AbortSignal): void;
};

const fullProviderId = (ownerId: string, providerId: string): string => `plugin:${ownerId}:${providerId}`;

/** 单个 Provider 失败或超时时返回空串，避免第三方插件拖住整轮对话。 */
async function resolveProvider(entry: PromptEntry, input: PluginPromptBuildInput): Promise<string> {
  const label = fullProviderId(entry.ownerId, entry.provider.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = Promise.resolve(entry.provider.provide({ ...input, signal: entry.signal }));
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`提示词 Provider 超时（${PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS}ms）`)),
        PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS,
      );
    });
    const produced = await Promise.race([pending, expiry]);
    if (typeof produced !== "string") throw new Error("提示词 Provider 必须返回字符串");

    const text = produced.trim();
    if (text.length > MAX_PLUGIN_PROMPT_CHARS) {
      console.warn(`[plugins] ${label} 提示词超过 ${MAX_PLUGIN_PROMPT_CHARS} 字符，已截断`);
      return text.slice(0, MAX_PLUGIN_PROMPT_CHARS);
    }
    return text;
  } catch (error) {
    console.warn(`[plugins] ${label} 提示词生成失败，已跳过`, error);
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertProviderShape(provider: PluginPromptProvider): void {
  if (!provider || typeof provider !== "object") throw new Error("插件提示词 Provider 必须是对象");
  if (!PROMPT_ID_RE.test(provider.id)) throw new Error(`非法插件提示词 Provider id: ${provider.id}`);
  if (typeof provider.provide !== "function") throw new Error("插件提示词 Provider 必须提供 provide() 函数");

  const { modes, sources } = provider;
  if (modes && (!Array.isArray(modes) || modes.some((m) => !KNOWN_MODES.includes(m)))) {
    throw new Error("插件提示词 Provider modes 含未知模式");
  }
  // sources 是显式的场景声明：必须是非空数组且只含合法场景，否则拼写错误会悄悄失效。
  // 这里用 !== undefined 而不是真值判断，false/0 之类的假值也要在注册时拒绝，
  // 否则会拖到 build 过滤的 includes() 才抛 TypeError，拖垮整个 registry。
  if (sources !== undefined && (
    !Array.isArray(sources)
    || sources.length === 0
    || sources.some((s) => !KNOWN_SOURCES.includes(s))
  )) {
    throw new Error(`插件提示词 Provider sources 非法: ${JSON.stringify(sources)}`);
  }
}

export function createPluginPromptRegistry(): PluginPromptRegistry {
  const registered = new Map<string, PromptEntry>();

  const register: PluginPromptRegistry["register"] = (ownerId, provider, signal) => {
    assertProviderShape(provider);
    const key = fullProviderId(ownerId, provider.id);
    if (registered.has(key)) throw new Error(`插件提示词 Provider 已注册: ${provider.id}`);
    registered.set(key, { ownerId, provider, signal });
  };

  const unregister: PluginPromptRegistry["unregister"] = (ownerId, providerId) =>
    registered.delete(fullProviderId(ownerId, providerId));

  const build: PluginPromptRegistry["build"] = async (input) => {
    // 先取快照再并行执行，结果仍按注册顺序拼接，运行期间增删不影响本轮内容
    const eligible = [...registered.values()].filter(({ signal, provider }) => {
      if (signal.aborted) return false;
      // 场景匹配：未声明 sources 的 Provider 只参与旧有场景
      if (!(provider.sources ?? LEGACY_PROMPT_SOURCES).includes(input.source)) return false;
      // 会话类场景按 modes 匹配；判别联合保证此时 mode 必填
      return !provider.modes || provider.modes.includes(input.mode);
    });
    const outputs = await Promise.all(eligible.map((entry) => resolveProvider(entry, input)));

    const blocks: string[] = [];
    let used = 0;
    for (let i = 0; i < eligible.length; i++) {
      const text = outputs[i];
      if (!text) continue;

      const label = fullProviderId(eligible[i].ownerId, eligible[i].provider.id);
      const divider = blocks.length > 0 ? "\n\n---\n\n" : "";
      const title = `[插件上下文：${label}]\n`;
      const room = MAX_PLUGIN_PROMPT_TOTAL_CHARS - used - divider.length - title.length;
      if (room <= 0) {
        console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已忽略后续内容`);
        break;
      }

      const kept = text.slice(0, room);
      blocks.push(divider + title + kept);
      used += divider.length + title.length + kept.length;
      if (kept.length < text.length) {
        console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已截断`);
        break;
      }
    }
    return blocks.join("");
  };

  return { register, unregister, build, clear: () => registered.clear() };
}

export const pluginPromptRegistry = createPluginPromptRegistry();
