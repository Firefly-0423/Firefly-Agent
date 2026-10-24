import { showNotice, showAlert } from "../shared/modal";

function clearSelection(cards: NodeListOf<HTMLButtonElement>): void {
  cards.forEach(button => button.classList.remove("is-active"));
}
function restoreSelection(cards: NodeListOf<HTMLButtonElement>, previous: string | undefined, key: string, suffix: string): void {
  clearSelection(cards);
  if (!previous) return;
  const former = document.querySelector('.rag-model-card[data-value="' + previous + '"]' + suffix);
  former?.classList.add("is-active");
  localStorage.setItem(key, previous);
}

function bindEmbeddingCards(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".rag-model-card:not([data-reranker])");
  const storageKey = "firefly.rag.model";
  const initial = localStorage.getItem(storageKey) || "bgem3";
  buttons.forEach(button => {
    const model = button.dataset.value;
    if (!model) return;
    button.classList.toggle("is-active", model === initial);
    button.addEventListener("click", async () => {
      const former = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
      const previous = former?.dataset.value;
      clearSelection(buttons);
      button.classList.add("is-active");
      localStorage.setItem(storageKey, model);
      try {
        const switched = await (window as any).settings?.embeddingSetModel?.(model);
        if (switched?.ok) {
          console.log("[settings] embedding switched to", model, "cleared:", switched.clearedEntries);
          if (switched.clearedEntries && switched.clearedEntries > 0) {
            showNotice({ tone: "info", message: `已切换至 BGE-M3，并清除 ${switched.clearedEntries} 条旧向量记忆。` });
          }
        } else {
          restoreSelection(buttons, previous, storageKey, ":not([data-reranker])");
          await showAlert({ tone: "error", title: "模型切换失败", message: "已恢复此前选择。", details: switched?.error || "未知错误" });
        }
      } catch (failure) {
        restoreSelection(buttons, previous, storageKey, ":not([data-reranker])");
        console.error("[settings] embedding switch error:", failure);
      }
    });
  });
}

function bindRerankerCards(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".rag-model-card[data-reranker]");
  const storageKey = "firefly.reranker.mode";
  const initial = localStorage.getItem(storageKey) || "standard";
  buttons.forEach(button => {
    const mode = button.dataset.value;
    if (!mode) return;
    button.classList.toggle("is-active", mode === initial);
    button.addEventListener("click", async () => {
      const former = document.querySelector(".rag-model-card.is-active[data-reranker]") as HTMLElement | null;
      const previous = former?.dataset.value;
      clearSelection(buttons);
      button.classList.add("is-active");
      localStorage.setItem(storageKey, mode);
      try {
        await (window as any).settings?.rerankerSetMode?.(mode);
      } catch (failure) {
        restoreSelection(buttons, previous, storageKey, "[data-reranker]");
        console.warn("[Reranker] set mode failed:", failure);
      }
    });
  });
}

async function loadRerankerStatus(): Promise<void> {
  const label = document.getElementById("reranker-standard-status");
  try {
    const installed = await (window as any).settings?.getRerankerStatus?.();
    if (!installed) return;
    if (label) label.textContent = installed.standard ? "已下载 · 约 279MB" : "未下载 · 可选";
  } catch (failure) {
    console.warn("[Reranker] status check failed:", failure);
    if (label) label.textContent = "状态未知";
  }
}
async function loadEmbeddingStatus(): Promise<void> {
  const label = document.getElementById("embedding-bgem3-status");
  try {
    const installed = await window.modelConfig?.getModelInstallStatus?.();
    if (!installed) {
      if (label) label.textContent = "状态未知";
      return;
    }
    if (label) label.textContent = installed.embedding?.bgem3 ? "已下载 · 约 570MB" : "未下载";
  } catch (failure) {
    console.warn("[Embedding] status check failed:", failure);
    if (label) label.textContent = "状态未知";
  }
}

bindEmbeddingCards();
bindRerankerCards();
void loadRerankerStatus();
void loadEmbeddingStatus();