// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../../shared/custom-endpoint-state";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function openCustomEndpointDraft(mode: "cloud" | "local"): void {
  byId<HTMLButtonElement>("add-profile-btn").click();
  byId<HTMLButtonElement>("provider-custom-tab").click();
  const modeBtn = document.querySelector<HTMLButtonElement>(`button[data-custom-endpoint-mode="${mode}"]`);
  if (!modeBtn) throw new Error(`Missing custom endpoint mode button ${mode}`);
  modeBtn.click();
}

describe("settings api testActiveConnection integration (T4)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("blocks timeout persistence and testConnection when endpoint validation or model/url prerequisites fail", async () => {
    const saveTimeoutSettings = vi.fn();
    const testConnection = vi.fn();
    await mountSettingsPage({
      settings: { saveTimeoutSettings, testConnection },
    });

    openCustomEndpointDraft("cloud");
    const testBtn = byId<HTMLButtonElement>("test-connection-btn");
    const status = byId<HTMLElement>("save-status");
    const baseUrlInput = byId<HTMLInputElement>("base-url");
    const modelInput = byId<HTMLInputElement>("model-input");
    const apiKeyInput = byId<HTMLInputElement>("api-key");

    baseUrlInput.value = "";
    modelInput.value = "gpt-4o";
    apiKeyInput.value = "sk-test";
    testBtn.click();
    await flushMicrotasks();

    expect(saveTimeoutSettings).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.textContent).toBeTruthy();

    baseUrlInput.value = "https://custom.example/v1";
    modelInput.value = "gpt-4o";
    apiKeyInput.value = "";
    testBtn.click();
    await flushMicrotasks();

    expect(saveTimeoutSettings).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(status.classList.contains("is-error")).toBe(true);
  });

  it("blocks timeout persistence and testConnection when built-in preset lacks baseUrl or model", async () => {
    const saveTimeoutSettings = vi.fn();
    const testConnection = vi.fn();
    await mountSettingsPage({
      settings: { saveTimeoutSettings, testConnection },
    });

    byId<HTMLButtonElement>("add-profile-btn").click();
    const testBtn = byId<HTMLButtonElement>("test-connection-btn");
    const status = byId<HTMLElement>("save-status");

    byId<HTMLInputElement>("model-input").value = "";
    testBtn.click();
    await flushMicrotasks();

    expect(saveTimeoutSettings).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(status.textContent).toBe("请先选择/填写模型再测试");
    expect(status.classList.contains("is-error")).toBe(true);

    byId<HTMLInputElement>("base-url").value = "";
    byId<HTMLInputElement>("model-input").value = "deepseek-v4-pro";
    testBtn.click();
    await flushMicrotasks();

    expect(saveTimeoutSettings).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(status.textContent).toBe("请先填写 API URL 再测试");
    expect(status.classList.contains("is-error")).toBe(true);
  });

  it("blocks testConnection when #timeout-test is invalid ('0')", async () => {
    const saveTimeoutSettings = vi.fn();
    const testConnection = vi.fn();
    await mountSettingsPage({
      settings: { saveTimeoutSettings, testConnection },
    });

    openCustomEndpointDraft("local");
    byId<HTMLInputElement>("base-url").value = "http://127.0.0.1:11434/v1";
    byId<HTMLInputElement>("model-input").value = "qwen2.5:7b";
    byId<HTMLInputElement>("api-key").value = "";
    byId<HTMLInputElement>("timeout-test").value = "0";

    const testBtn = byId<HTMLButtonElement>("test-connection-btn");
    const status = byId<HTMLElement>("save-status");
    testBtn.click();
    await flushMicrotasks();

    expect(saveTimeoutSettings).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(status.textContent).toBe("无效输入：测试超时");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(testBtn.disabled).toBe(false);
  });

  it("persists testTimeout before invoking testConnection with local auth fallback key and full payload", async () => {
    const callOrder: string[] = [];
    let resolveTest!: (value: { ok: boolean; latency: number; sample?: string; error?: string }) => void;
    let resolveSave!: () => void;

    const saveTimeoutSettings = vi.fn((patch) => {
      callOrder.push("saveTimeoutSettings");
      return new Promise((resolve) => {
        resolveSave = () => resolve({ userChoiceTimeout: 60000, testTimeout: 15000, ...patch });
      });
    });
    const testConnection = vi.fn(() => {
      callOrder.push("testConnection");
      return new Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>((resolve) => {
        resolveTest = resolve;
      });
    });

    await mountSettingsPage({
      settings: { saveTimeoutSettings, testConnection },
    });

    openCustomEndpointDraft("local");
    byId<HTMLInputElement>("base-url").value = "http://127.0.0.1:11434/v1";
    byId<HTMLInputElement>("model-input").value = "qwen3:8b";
    byId<HTMLInputElement>("api-key").value = "";
    byId<HTMLInputElement>("timeout-test").value = "25";

    const anthropicTransport = document.querySelector<HTMLButtonElement>('#transport-select button[data-value="anthropic"]');
    if (!anthropicTransport) throw new Error("Missing anthropic transport card");
    anthropicTransport.click();

    const testBtn = byId<HTMLButtonElement>("test-connection-btn");
    const status = byId<HTMLElement>("save-status");
    testBtn.click();
    await flushMicrotasks();

    // The connection test starts only after the timeout write has finished.
    expect(callOrder).toEqual(["saveTimeoutSettings"]);
    expect(testConnection).not.toHaveBeenCalled();

    resolveSave();
    await flushMicrotasks();

    expect(callOrder).toEqual(["saveTimeoutSettings", "testConnection"]);
    expect(saveTimeoutSettings).toHaveBeenCalledExactlyOnceWith({ testTimeout: 25 });
    expect(testConnection).toHaveBeenCalledExactlyOnceWith({
      provider: CUSTOM_ENDPOINT_PROVIDERS.local,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      apiKey: "__FIREFLY_LOCAL_NO_AUTH__",
      explicitTransport: "anthropic",
      reasoning: undefined,
    });
    expect(testBtn.disabled).toBe(true);
    expect(status.textContent).toBe("测试连接中…");

    resolveTest({ ok: true, latency: 42, sample: "hello" });
    await flushMicrotasks();

    expect(testBtn.disabled).toBe(false);
    expect(status.textContent).toBe("连接成功 42ms · hello");
    expect(status.classList.contains("is-ok")).toBe(true);
    expect(status.classList.contains("is-error")).toBe(false);
  });

  it("skips testConnection when the timeout save fails", async () => {
    const saveTimeoutSettings = vi.fn(async () => {
      throw new Error("ipc write failed");
    });
    const testConnection = vi.fn();
    await mountSettingsPage({
      settings: { saveTimeoutSettings, testConnection },
    });

    openCustomEndpointDraft("local");
    byId<HTMLInputElement>("base-url").value = "http://127.0.0.1:11434/v1";
    byId<HTMLInputElement>("model-input").value = "qwen3:8b";
    byId<HTMLInputElement>("timeout-test").value = "25";

    const testBtn = byId<HTMLButtonElement>("test-connection-btn");
    const status = byId<HTMLElement>("save-status");
    testBtn.click();
    await flushMicrotasks();

    expect(saveTimeoutSettings).toHaveBeenCalledExactlyOnceWith({ testTimeout: 25 });
    expect(testConnection).not.toHaveBeenCalled();
    expect(status.textContent).toBe("保存失败");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(testBtn.disabled).toBe(false);
  });

  it("reports error details and restores button enabled state on failed response or rejection", async () => {
    const testConnection = vi.fn();
    await mountSettingsPage({
      settings: { testConnection },
    });

    openCustomEndpointDraft("local");
    byId<HTMLInputElement>("base-url").value = "http://127.0.0.1:11434/v1";
    byId<HTMLInputElement>("model-input").value = "qwen3:8b";
    byId<HTMLInputElement>("timeout-test").value = "15";

    const testBtn = byId<HTMLButtonElement>("test-connection-btn");
    const status = byId<HTMLElement>("save-status");

    testConnection.mockResolvedValueOnce({ ok: false, latency: 10, error: "401 Unauthorized" });
    testBtn.click();
    await flushMicrotasks();

    expect(status.textContent).toBe("连接失败：401 Unauthorized");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.classList.contains("is-ok")).toBe(false);
    expect(testBtn.disabled).toBe(false);

    testConnection.mockResolvedValueOnce({ ok: false, latency: 10 });
    testBtn.click();
    await flushMicrotasks();

    expect(status.textContent).toBe("连接失败：未知错误");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(testBtn.disabled).toBe(false);

    testConnection.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    testBtn.click();
    await flushMicrotasks();

    expect(status.textContent).toBe("连接失败：ECONNREFUSED");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(testBtn.disabled).toBe(false);
  });
});
