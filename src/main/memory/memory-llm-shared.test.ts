import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsState = vi.hoisted(() => ({
  assertReadable: vi.fn(),
  load: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../settings/model-settings", () => ({
  assertModelSettingsReadable: settingsState.assertReadable,
  loadModelSettings: settingsState.load,
  resolveModelSettingsProfile: settingsState.resolve,
}));

import { loadMemoryModelConfig } from "./memory-llm-shared";

describe("memory model configuration", () => {
  beforeEach(() => {
    settingsState.assertReadable.mockReset();
    settingsState.load.mockReset();
    settingsState.resolve.mockReset();
  });

  it("uses the current default saved model without reading another settings file", () => {
    const settings = { modelProfiles: [{ id: "saved" }] };
    settingsState.load.mockReturnValue(settings);
    settingsState.resolve.mockReturnValue({
      provider: "ChatGPT（OpenAI）", baseUrl: "https://api.example.test/v1", model: "test-model",
      apiKey: "test-key", explicitTransport: "responses",
    });

    expect(loadMemoryModelConfig()).toEqual({
      source: "inherited-main", provider: "ChatGPT（OpenAI）", baseUrl: "https://api.example.test/v1",
      model: "test-model", apiKey: "test-key", explicitTransport: "responses",
    });
    expect(settingsState.assertReadable).toHaveBeenCalledOnce();
    expect(settingsState.resolve).toHaveBeenCalledWith(settings);
  });

  it("does not supply an old provider or key when no model is configured", () => {
    settingsState.load.mockReturnValue({ modelProfiles: [] });
    settingsState.resolve.mockReturnValue({ provider: "MiniMax（稀宇科技）", baseUrl: "", model: "", apiKey: "" });

    expect(loadMemoryModelConfig()).toMatchObject({ source: "inherited-main", apiKey: "" });
  });

  it("propagates a settings read failure instead of falling back", () => {
    settingsState.assertReadable.mockImplementation(() => { throw new Error("MODEL_SETTINGS_READ_FAILED"); });
    expect(loadMemoryModelConfig).toThrow("MODEL_SETTINGS_READ_FAILED");
    expect(settingsState.resolve).not.toHaveBeenCalled();
  });
});
