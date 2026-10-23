import { describe, expect, it } from "vitest";
import { MODEL_PRESETS, sortPresetsForDisplay } from "./presets";
import { getCapability } from "../../../main/orchestrator/vendors/capabilities";

describe("MODEL_PRESETS — OpenRouter 预设", () => {
  const preset = MODEL_PRESETS.find((item) => item.providerName === "OpenRouter");

  it("存在于预设列表，短名为 OpenRouter，且可选（不是 disabled、不是隐藏或自定义端点）", () => {
    expect(preset).toBeDefined();
    expect(preset).toMatchObject({ providerName: "OpenRouter", shortName: "OpenRouter" });
    expect(preset?.disabled).toBeFalsy();
    expect(preset?.hiddenInPresetList).toBeFalsy();
    expect(preset?.customEndpointMode).toBeUndefined();
  });

  it("Base URL 为 OpenRouter 官方 OpenAI 兼容地址，协议显式为 openai（不走 Responses）", () => {
    expect(preset?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(preset?.transport).toBe("openai");
  });

  it("不预置任何型号 id，型号由“获取模型列表”拉取后选择", () => {
    expect(preset?.mainModels).toEqual([]);
  });

  it("与厂商能力表对齐：同名条目的 Base URL 与协议一致", () => {
    const capability = getCapability("OpenRouter");
    expect(capability?.baseUrl).toBe(preset?.baseUrl);
    expect(capability?.transport).toBe(preset?.transport);
  });
});

describe("provider card display order", () => {
  const visible = (presets: typeof MODEL_PRESETS) =>
    presets.filter((item) => !item.hiddenInPresetList && !item.customEndpointMode).map((item) => item.shortName);

  it("lists vendors by first letter A to Z", () => {
    expect(visible(sortPresetsForDisplay(MODEL_PRESETS))).toEqual(
      ["ChatGPT", "Claude", "DeepSeek", "GLM", "Kimi", "MiMo", "MiniMax", "OpenRouter", "Qwen"],
    );
  });

  it("does not reorder the source list, which still decides the default new profile", () => {
    const before = MODEL_PRESETS.map((item) => item.providerName);

    sortPresetsForDisplay(MODEL_PRESETS);

    expect(MODEL_PRESETS.map((item) => item.providerName)).toEqual(before);
    expect(MODEL_PRESETS.find((item) => !item.disabled && !item.customEndpointMode)?.shortName).toBe("MiniMax");
  });

  it("gives OpenRouter its own brand icon instead of the generic custom-endpoint one", () => {
    const icon = MODEL_PRESETS.find((item) => item.providerName === "OpenRouter")?.iconUrl;

    expect(icon).toBe("../icons/providers/openrouter.svg");
  });
});
