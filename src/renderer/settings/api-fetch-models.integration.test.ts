// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_PRESETS } from "./api/presets";
import type { FetchedModel } from "./shared/types";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

type FetchModelsResponse = { ok: true; models: FetchedModel[] } | { ok: false; error: string };

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function suggestionValues(): string[] {
  return Array.from(
    byId<HTMLDataListElement>("model-input-suggestions").querySelectorAll("option"),
    (opt) => opt.value,
  );
}

function pickerModelIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("#fetch-models-list [data-model-id]"),
    (el) => el.dataset.modelId!,
  );
}

describe("settings api fetchModels race protection & error mapping (T5)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("disables fetchModelsBtn while in flight to block duplicate clicks and closes an open picker before refetching", async () => {
    const first = deferred<FetchModelsResponse>();
    const second = deferred<FetchModelsResponse>();
    const fetchModels = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await mountSettingsPage({ settings: { fetchModels } });
    byId<HTMLButtonElement>("add-profile-btn").click();
    byId<HTMLInputElement>("api-key").value = "sk-deepseek";

    const fetchBtn = byId<HTMLButtonElement>("fetch-models-btn");
    const status = byId<HTMLElement>("fetch-models-status");
    const picker = byId<HTMLElement>("fetch-models-picker");

    fetchBtn.click();
    expect(fetchBtn.disabled).toBe(true);
    expect(status.textContent).toBe("正在向厂商获取…");
    expect(status.classList.contains("is-error")).toBe(false);
    expect(status.classList.contains("is-ok")).toBe(false);
    expect(fetchModels).toHaveBeenCalledTimes(1);

    // Rapid second click while pending is blocked because the button is disabled.
    fetchBtn.click();
    expect(fetchModels).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true, models: [{ id: "deepseek-old-a" }] });
    await flushMicrotasks();

    expect(fetchBtn.disabled).toBe(false);
    expect(picker.hidden).toBe(false);
    expect(pickerModelIds()).toEqual(["deepseek-old-a"]);
    expect(suggestionValues()).toEqual(["deepseek-old-a"]);
    expect(status.textContent).toBe("已从厂商获取 1 个型号，点下面的列表选择。");
    expect(status.classList.contains("is-ok")).toBe(true);

    // Starting a new fetch closes the previous picker immediately while loading.
    fetchBtn.click();
    expect(picker.hidden).toBe(true);
    expect(fetchBtn.disabled).toBe(true);
    expect(fetchModels).toHaveBeenCalledTimes(2);

    second.resolve({ ok: true, models: [{ id: "deepseek-new-b" }, { id: "deepseek-new-c" }] });
    await flushMicrotasks();

    expect(fetchBtn.disabled).toBe(false);
    expect(picker.hidden).toBe(false);
    expect(pickerModelIds()).toEqual(["deepseek-new-b", "deepseek-new-c"]);
    expect(suggestionValues()).toEqual(["deepseek-new-b", "deepseek-new-c"]);
    expect(status.textContent).toBe("已从厂商获取 2 个型号，点下面的列表选择。");
  });

  it("ignores stale fetchModels resolution after switching provider preset and keeps the new provider's fetched list", async () => {
    const staleFirst = deferred<FetchModelsResponse>();
    const freshSecond = deferred<FetchModelsResponse>();
    const fetchModels = vi.fn()
      .mockReturnValueOnce(staleFirst.promise)
      .mockReturnValueOnce(freshSecond.promise);

    await mountSettingsPage({ settings: { fetchModels } });
    byId<HTMLButtonElement>("add-profile-btn").click();

    const kimiPreset = MODEL_PRESETS.find((preset) => preset.shortName === "Kimi")!;
    const kimiCard = Array.from(document.querySelectorAll<HTMLButtonElement>("#preset-cards .preset-card"))
      .find((card) => card.dataset.provider === kimiPreset.providerName);
    if (!kimiCard) throw new Error("Missing Kimi preset card");

    const fetchBtn = byId<HTMLButtonElement>("fetch-models-btn");
    const status = byId<HTMLElement>("fetch-models-status");
    const picker = byId<HTMLElement>("fetch-models-picker");

    fetchBtn.click();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchBtn.disabled).toBe(true);

    // Switch provider while the first fetch is still pending; fillModelOptions bumps fetchModelsGeneration.
    kimiCard.click();
    expect(status.textContent).toBe("");
    expect(picker.hidden).toBe(true);
    const kimiDefaultSuggestions = suggestionValues();
    expect(kimiDefaultSuggestions).toEqual(kimiPreset.mainModels);

    // Stale first response resolves with old models: must NOT pollute DOM, suggestions, or status.
    staleFirst.resolve({
      ok: true,
      models: [{ id: "stale-deepseek-model", inputModalities: ["text", "image"] }],
    });
    await flushMicrotasks();

    expect(picker.hidden).toBe(true);
    expect(pickerModelIds()).toEqual([]);
    expect(suggestionValues()).toEqual(kimiDefaultSuggestions);
    expect(status.textContent).toBe("");
    expect(status.classList.contains("is-ok")).toBe(false);
    expect(fetchBtn.disabled).toBe(false);

    // Fetch on Kimi now populates Kimi's models cleanly without stale entries.
    byId<HTMLInputElement>("api-key").value = "sk-kimi-fresh";
    fetchBtn.click();
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(fetchModels).toHaveBeenLastCalledWith({
      provider: kimiPreset.providerName,
      baseUrl: kimiPreset.baseUrl,
      apiKey: "sk-kimi-fresh",
      explicitTransport: kimiPreset.transport,
    });

    freshSecond.resolve({
      ok: true,
      models: [{ id: "kimi-k2-fresh" }, { id: "kimi-k2-vision" }],
    });
    await flushMicrotasks();

    expect(picker.hidden).toBe(false);
    expect(pickerModelIds()).toEqual(["kimi-k2-fresh", "kimi-k2-vision"]);
    expect(suggestionValues()).toEqual(["kimi-k2-fresh", "kimi-k2-vision"]);
    expect(status.textContent).toBe("已从厂商获取 2 个型号，点下面的列表选择。");
    expect(status.classList.contains("is-ok")).toBe(true);
  });

  it("ignores stale fetchModels error/rejection after switching provider preset", async () => {
    const staleError = deferred<FetchModelsResponse>();
    const staleReject = deferred<FetchModelsResponse>();
    const fetchModels = vi.fn()
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(staleReject.promise);

    await mountSettingsPage({ settings: { fetchModels } });
    byId<HTMLButtonElement>("add-profile-btn").click();

    const kimiPreset = MODEL_PRESETS.find((preset) => preset.shortName === "Kimi")!;
    const deepseekPreset = MODEL_PRESETS.find((preset) => preset.shortName === "DeepSeek")!;
    const cardOf = (providerName: string) => {
      const card = Array.from(document.querySelectorAll<HTMLButtonElement>("#preset-cards .preset-card"))
        .find((el) => el.dataset.provider === providerName);
      if (!card) throw new Error(`Missing preset card ${providerName}`);
      return card;
    };

    const fetchBtn = byId<HTMLButtonElement>("fetch-models-btn");
    const status = byId<HTMLElement>("fetch-models-status");

    fetchBtn.click();
    cardOf(kimiPreset.providerName).click();
    staleError.resolve({ ok: false, error: "HTTP_401" });
    await flushMicrotasks();

    expect(status.textContent).toBe("");
    expect(status.classList.contains("is-error")).toBe(false);
    expect(fetchBtn.disabled).toBe(false);

    fetchBtn.click();
    cardOf(deepseekPreset.providerName).click();
    staleReject.reject(new Error("socket hang up"));
    await flushMicrotasks();

    expect(status.textContent).toBe("");
    expect(status.classList.contains("is-error")).toBe(false);
    expect(fetchBtn.disabled).toBe(false);
  });

  it.each([
    { error: "HTTP_401", expected: "厂商拒绝了这个 Key（401），请检查 Key 和权限。" },
    { error: "HTTP_403", expected: "厂商拒绝了这个 Key（403），请检查 Key 和权限。" },
    { error: "HTTP_404", expected: "这个地址没有提供模型列表接口，请手填型号。" },
    { error: "HTTP_502", expected: "厂商返回了 502。" },
    { error: "MISSING_API_KEY", expected: "先填好 API Key 和 Base URL。" },
    { error: "MISSING_BASE_URL", expected: "先填好 API Key 和 Base URL。" },
    { error: "TIMEOUT", expected: "厂商没有及时响应。" },
    { error: "BAD_RESPONSE", expected: "返回的内容里没有型号列表，请手填型号。" },
    { error: "UNEXPECTED_CODE", expected: "连不上这个地址，请检查 Base URL 和网络。" },
  ])("maps fetchModels failure $error to '$expected'", async ({ error, expected }) => {
    const fetchModels = vi.fn().mockResolvedValueOnce({ ok: false, error });
    await mountSettingsPage({ settings: { fetchModels } });
    byId<HTMLButtonElement>("add-profile-btn").click();
    const beforeSuggestions = suggestionValues();

    const fetchBtn = byId<HTMLButtonElement>("fetch-models-btn");
    const status = byId<HTMLElement>("fetch-models-status");
    const picker = byId<HTMLElement>("fetch-models-picker");

    fetchBtn.click();
    await flushMicrotasks();

    expect(status.textContent).toBe(expected);
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.classList.contains("is-ok")).toBe(false);
    expect(picker.hidden).toBe(true);
    expect(fetchBtn.disabled).toBe(false);
    expect(suggestionValues()).toEqual(beforeSuggestions);
  });

  it("maps undefined response and rejected fetchModels call to network error message", async () => {
    const fetchModels = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await mountSettingsPage({ settings: { fetchModels } });
    byId<HTMLButtonElement>("add-profile-btn").click();

    const fetchBtn = byId<HTMLButtonElement>("fetch-models-btn");
    const status = byId<HTMLElement>("fetch-models-status");
    const picker = byId<HTMLElement>("fetch-models-picker");

    fetchBtn.click();
    await flushMicrotasks();
    expect(status.textContent).toBe("连不上这个地址，请检查 Base URL 和网络。");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(picker.hidden).toBe(true);
    expect(fetchBtn.disabled).toBe(false);

    fetchBtn.click();
    await flushMicrotasks();
    expect(status.textContent).toBe("连不上这个地址，请检查 Base URL 和网络。");
    expect(status.classList.contains("is-error")).toBe(true);
    expect(picker.hidden).toBe(true);
    expect(fetchBtn.disabled).toBe(false);
  });

  it("closes the fetched model picker on Escape, restores focus to fetchModelsBtn, and keeps the profile editor open", async () => {
    const fetchModels = vi.fn().mockResolvedValueOnce({
      ok: true,
      models: [{ id: "deepseek-v4" }, { id: "deepseek-r1" }],
    });

    await mountSettingsPage({ settings: { fetchModels } });
    byId<HTMLButtonElement>("add-profile-btn").click();
    byId<HTMLInputElement>("api-key").value = "sk-deepseek";

    const editor = byId<HTMLElement>("profile-editor");
    const fetchBtn = byId<HTMLButtonElement>("fetch-models-btn");
    const picker = byId<HTMLElement>("fetch-models-picker");
    const search = byId<HTMLInputElement>("fetch-models-search");

    fetchBtn.click();
    await flushMicrotasks();
    expect(picker.hidden).toBe(false);
    expect(editor.hidden).toBe(false);

    // Pressing Escape when focus is inside the picker search box closes only the picker.
    search.focus();
    const escFromSearch = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    search.dispatchEvent(escFromSearch);

    expect(escFromSearch.defaultPrevented).toBe(true);
    expect(picker.hidden).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(document.activeElement).toBe(fetchBtn);
    expect(document.getElementById("ff-modal-overlay")?.classList.contains("is-hidden") ?? true).toBe(true);

    // Re-open and press Escape while focus is on document.body (e.g. after fetch button disable/enable blur).
    fetchModels.mockResolvedValueOnce({
      ok: true,
      models: [{ id: "deepseek-v4" }],
    });
    fetchBtn.click();
    await flushMicrotasks();
    expect(picker.hidden).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur?.();

    const escFromBody = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escFromBody);

    expect(escFromBody.defaultPrevented).toBe(true);
    expect(picker.hidden).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(document.activeElement).toBe(fetchBtn);
  });
});
