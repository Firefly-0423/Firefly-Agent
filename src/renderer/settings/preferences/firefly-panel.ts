import type {} from "../../global";
import { embeddingDimensionsInput } from "../api/dom";
import { t } from "../i18n";
import { applyOptionGroupValue, getOptionGroupValue, onChoice } from "../shared/option-group";
import { bindSettingsSubmit, setFireflySaveStatus } from "../shared/save-status";
import { fireflyPanel } from "../shared/shell";
import type { ModelSettings } from "../shared/types";
import { stickerEnabledInput, stickerSizeSelect, stickerThresholdInput, stickerThresholdVal } from "./dom";
import { renderStickerSendStatus } from "./sticker-send-status";

function stickerSize(value: string | undefined): "small" | "standard" | "large" {
  if (value === "small" || value === "large") return value;
  return "standard";
}

function getStickerSizeValue(): "small" | "standard" | "large" {
  return stickerSize(getOptionGroupValue(stickerSizeSelect, "standard"));
}

function applyStickerSizeSelection(size: "small" | "standard" | "large"): void {
  applyOptionGroupValue(stickerSizeSelect, size);
}

function syncStickerSendStatus(): void {
  const display = document.getElementById("sticker-send-status");
  if (display) renderStickerSendStatus(display, stickerEnabledInput.checked);
}

const dirtyStickers = (): void => setFireflySaveStatus(t("settings.status.dirty"));

function embeddingDimensions(): number | undefined {
  const entered = embeddingDimensionsInput?.value?.trim();
  const number = entered ? Number(entered) : NaN;
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.max(1, Math.min(65536, Math.round(number)));
}

/** 绑定流萤表情包开关/尺寸/阈值与向量维度保存表单。 */
export function initFireflyPanel(): void {
  stickerEnabledInput.addEventListener("change", () => {
    syncStickerSendStatus();
    dirtyStickers();
  });
  onChoice(stickerSizeSelect, ".option-block", option => {
    applyStickerSizeSelection(stickerSize(option.dataset.value));
    dirtyStickers();
  });
  stickerThresholdInput.addEventListener("input", () => {
    stickerThresholdVal.textContent = parseFloat(stickerThresholdInput.value).toFixed(2);
    dirtyStickers();
  });

  bindSettingsSubmit(fireflyPanel, setFireflySaveStatus, () => {
    const dimensions = embeddingDimensions();
    return window.settings!.saveConfig({
      stickerEnabled: stickerEnabledInput.checked,
      stickerSize: getStickerSizeValue(),
      stickerSimilarityThreshold: parseFloat(stickerThresholdInput.value),
      embeddingDimensions: dimensions,
    });
  });
}

/** 用单次 `getConfig()` 结果回填流萤面板控件。 */
export function hydrateFireflyConfig(config: ModelSettings): void {
  stickerEnabledInput.checked = config.stickerEnabled !== false;
  syncStickerSendStatus();
  applyStickerSizeSelection(config.stickerSize);
  const similarity = config.stickerSimilarityThreshold ?? 0.55;
  stickerThresholdInput.value = String(similarity);
  stickerThresholdVal.textContent = similarity.toFixed(2);
  if (embeddingDimensionsInput) embeddingDimensionsInput.value = config.embeddingDimensions ? String(config.embeddingDimensions) : "";
}
