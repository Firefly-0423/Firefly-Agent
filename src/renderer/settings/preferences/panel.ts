import { setPreferencesSaveStatus } from "../shared/save-status";
import { screenshotHotkeyInput } from "../appearance/dom";
import { preferencesState } from "./state";
import { stickerAddError, stickerAddConfirm, stickerAddCancel, stickerAddPickBtn, stickerAddFileName, stickerAddId, stickerAddDesc, stickerAddPhrases, stickerAddOverlay } from "./dom";
import { addStickerBtn, openStickerManagerBtn } from "../shared/shell";
import { showAlert } from "../shared/modal";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);
async function beginHotkeyCapture(): Promise<void> {
  await window.settings!.beginScreenshotHotkeyCapture();
}
async function finishHotkeyCapture(): Promise<void> {
  await window.settings!.endScreenshotHotkeyCapture();
}
screenshotHotkeyInput?.addEventListener("focus", beginHotkeyCapture);
screenshotHotkeyInput?.addEventListener("blur", finishHotkeyCapture);

function captureHotkey(event: KeyboardEvent): void {
  event.preventDefault();
  if (event.key === "Escape" || event.key === "Enter") {
    screenshotHotkeyInput!.blur();
    return;
  }
  const chord: string[] = [];
  if (event.ctrlKey) chord.push("Ctrl");
  if (event.altKey) chord.push("Alt");
  if (event.shiftKey) chord.push("Shift");
  if (event.metaKey) chord.push("Super");
  if (MODIFIER_KEYS.has(event.key)) return;
  chord.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  if (chord.length < 2) return;
  screenshotHotkeyInput!.value = chord.join("+");
  setPreferencesSaveStatus("有未保存的更改");
}
screenshotHotkeyInput?.addEventListener("keydown", captureHotkey);

openStickerManagerBtn.addEventListener("click", async () => {
  console.log("[settings] open sticker manager clicked");
  try {
    const opened = await window.settings?.openStickerManager();
    if (!opened?.ok) {
      console.error("[settings] open sticker manager failed", opened?.error);
      await showAlert({ tone: "error", title: "表情包管理窗口打开失败", message: "请查看终端日志后重试。", details: opened?.error || undefined });
    }
  } catch (failure) {
    console.error("[settings] open sticker manager error", failure);
    await showAlert({ tone: "error", title: "表情包管理窗口打开失败", message: "请查看终端日志后重试。", details: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure) });
  }
});

function openStickerAddModal(): void {
  preferencesState.stickerAddPickedPath = null;
  stickerAddFileName.textContent = "未选择";
  for (const input of [stickerAddId, stickerAddDesc, stickerAddPhrases]) input.value = "";
  stickerAddError.classList.add("is-hidden");
  stickerAddOverlay.classList.remove("is-hidden");
}
function closeStickerAddModal(): void { stickerAddOverlay.classList.add("is-hidden"); }
function rejectSticker(message: string): void {
  stickerAddError.textContent = message;
  stickerAddError.classList.remove("is-hidden");
}

addStickerBtn.addEventListener("click", openStickerAddModal);
stickerAddCancel.addEventListener("click", closeStickerAddModal);
stickerAddPickBtn.addEventListener("click", async () => {
  const picked = await window.settings?.stickerPickFile?.();
  if (!picked) return;
  preferencesState.stickerAddPickedPath = picked;
  const fileName = picked.split(/[\\/]/).pop() || picked;
  stickerAddFileName.textContent = fileName;
  if (!stickerAddId.value) {
    const withoutExtension = fileName.replace(/\.[^.]+$/, "");
    stickerAddId.value = withoutExtension.replace(/[^a-zA-Z0-9_-]/g, "");
  }
});

stickerAddConfirm.addEventListener("click", async () => {
  stickerAddError.classList.add("is-hidden");
  if (!preferencesState.stickerAddPickedPath) return rejectSticker("请先选择图片文件");
  const stickerId = stickerAddId.value.trim();
  if (!stickerId) return rejectSticker("请填写英文名称");
  if (!/^[a-zA-Z0-9_-]+$/.test(stickerId)) return rejectSticker("名称只能用英文字母、数字、下划线和连字符");
  const caption = stickerAddDesc.value.trim();
  if (!caption) return rejectSticker("请填写图片描述");
  const meanings = stickerAddPhrases.value.split("\n").map(line => line.trim()).filter(Boolean);
  if (meanings.length === 0) return rejectSticker("请至少写一行相近语义");
  try {
    await window.settings?.stickerAdd?.({ sourcePath: preferencesState.stickerAddPickedPath, id: stickerId, description: caption, phrases: meanings });
    closeStickerAddModal();
  } catch (failure) {
    rejectSticker("添加失败：" + (failure as Error).message);
  }
});
