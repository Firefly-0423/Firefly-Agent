import type {} from "../../global";
import { type ApiTransport } from "../../../shared/api-endpoint";
import { apiState } from "./state";
import { createModelPicker } from "./model-picker";
import { createInputModalitiesPanel, type InputModalitiesPanel } from "./input-modalities";
import { inputModalitiesSelect, inputModalitiesHint } from "./dom";
import type { InputModality } from "../../../shared/input-modalities";
import { baseUrlInput, modelInput, modelInputSuggestions, transportSelect, fetchModelsBtn, fetchModelsStatus, fetchModelsPicker, fetchModelsSearch, fetchModelsList, fetchModelsEmpty } from "./dom";
import type { ModelPreset } from "../shared/types";
import { t } from "../i18n";

export function initFetchModelsController(hooks: { updateProfileDraftState: () => void; getApiKeyForRequest: () => string }) {
  const { updateProfileDraftState, getApiKeyForRequest } = hooks;
  // 表单每次被填成另一个档案 / 厂商，就作废还在路上的“获取模型列表”，并收起上一个档案的候选列表。
  // 输入类型面板：三态控件 + 生效结果说明；状态与保存口径见 api/input-modalities.ts。
  const inputModalities: InputModalitiesPanel = createInputModalitiesPanel({ select: inputModalitiesSelect, hint: inputModalitiesHint }, {
    getProvider: () => apiState.activeProvider,
    getModel: () => modelInput.value.trim(),
    resolve: (input) => window.settings?.resolveInputModalities?.(input) ?? Promise.resolve(undefined),
    t: (key) => t(key),
    onChange: () => updateProfileDraftState(),
  });
  /** 最近一次“获取模型列表”给出的各型号输入模态；选中某个型号时记为厂商接口记录。 */
  const fetchedInputModalities = new Map<string, InputModality[] | undefined>();
  let fetchModelsGeneration = 0;
  let closeFetchedModelPicker: () => void = () => {};
  function fillModelSuggestions(models: readonly { id: string; name?: string }[]): void {
    modelInputSuggestions.replaceChildren();
    models.forEach(({ id, name }) => {
      const suggestion = document.createElement("option");
      suggestion.value = id;
      if (name) suggestion.label = name;
      modelInputSuggestions.appendChild(suggestion);
    });
  }

  function fillModelOptions(preset: ModelPreset, preferredModel?: string): void {
    ++fetchModelsGeneration;
    fetchedInputModalities.clear();
    closeFetchedModelPicker();
    if (fetchModelsStatus) {
      fetchModelsStatus.textContent = "";
      fetchModelsStatus.classList.remove("is-error", "is-ok");
    }
    fillModelSuggestions(preset.mainModels.map(id => ({ id })));
    modelInput.value = preferredModel ?? preset.mainModels[0] ?? "";
    inputModalities.modelChanged();
  }

  function bind(): void {
    // ── 从厂商获取模型列表：型号由接入的厂商决定，预设只是拉不到时的兜底建议 ──
    const modelPicker = fetchModelsPicker && fetchModelsSearch && fetchModelsList && fetchModelsEmpty
      ? createModelPicker({ root: fetchModelsPicker, search: fetchModelsSearch, list: fetchModelsList, empty: fetchModelsEmpty }, (id) => {
        modelInput.value = id;
        modelInput.dispatchEvent(new Event("input", { bubbles: true }));
        inputModalities.picked(id, fetchedInputModalities.get(id));
      })
      : undefined;
    closeFetchedModelPicker = () => modelPicker?.close();
    modelInput.addEventListener("input", () => {
      const typed = modelInput.value.trim();
      modelPicker?.syncCurrent(typed);
      inputModalities.modelChanged();
      // 原生 datalist 选中（或手填成了列表里的 id）不会经过自定义选择器；
      // 只要这个 id 是刚拉取到的厂商模型，就按厂商返回的模态记录，避免图片能力被静默丢掉。
      if (fetchedInputModalities.has(typed)) inputModalities.picked(typed, fetchedInputModalities.get(typed));
    });
    function fetchModelsErrorText(error: string): string {
      const status = /^HTTP_(\d+)$/.exec(error)?.[1];
      if (status === "401" || status === "403") return t("settings.panel.api.field.model.fetch.unauthorized", { status });
      if (status === "404") return t("settings.panel.api.field.model.fetch.notFound");
      if (status) return t("settings.panel.api.field.model.fetch.http", { status });
      if (error === "MISSING_API_KEY" || error === "MISSING_BASE_URL") return t("settings.panel.api.field.model.fetch.needKey");
      if (error === "TIMEOUT") return t("settings.panel.api.field.model.fetch.timeout");
      if (error === "BAD_RESPONSE") return t("settings.panel.api.field.model.fetch.empty");
      return t("settings.panel.api.field.model.fetch.network");
    }
    fetchModelsBtn?.addEventListener("click", async () => {
      if (!fetchModelsBtn || !fetchModelsStatus) return;
      const show = (text: string, tone: "" | "is-error" | "is-ok" = "") => {
        fetchModelsStatus.textContent = text;
        fetchModelsStatus.classList.remove("is-error", "is-ok");
        if (tone) fetchModelsStatus.classList.add(tone);
      };
      show(t("settings.panel.api.field.model.fetch.loading"));
      modelPicker?.close();
      fetchModelsBtn.disabled = true;
      const generation = fetchModelsGeneration;
      try {
        const result = await settings.fetchModels?.({
          provider: apiState.activeProvider,
          baseUrl: baseUrlInput.value.trim(),
          apiKey: getApiKeyForRequest(),
          explicitTransport: transportSelect.value as ApiTransport,
        });
        // 等待期间切到了别的档案：结果属于上一个档案，丢掉，不要写进现在这个档案的候选里
        if (generation !== fetchModelsGeneration) return;
        if (!result) { show(fetchModelsErrorText("NETWORK"), "is-error"); return; }
        if (!result.ok) { show(fetchModelsErrorText(result.error), "is-error"); return; }
        fetchedInputModalities.clear();
        for (const model of result.models) fetchedInputModalities.set(model.id, model.inputModalities);
        fillModelSuggestions(result.models);

        modelPicker?.open(result.models, modelInput.value.trim());
        show(t("settings.panel.api.field.model.fetch.done", { count: result.models.length }), "is-ok");
      } catch {
        if (generation === fetchModelsGeneration) show(fetchModelsErrorText("NETWORK"), "is-error");
      } finally {
        fetchModelsBtn.disabled = false;
      }
    });

  }
  return { inputModalities, fillModelOptions, bind };
}
