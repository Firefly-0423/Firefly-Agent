// 从厂商拉到型号后的候选列表：可搜索，点一项填进"模型名"。
// 厂商的型号数量从几个到几百个不等（网关、OpenRouter），datalist 只能靠方向键翻，所以单独做一个列表。
import type { InputModality } from "../../../shared/input-modalities";

export interface PickerModel {
  id: string;
  name?: string;
  /** 厂商声明的输入模态；picker 本身不展示，选中时由设置页读取（见 input-modalities.ts）。 */
  inputModalities?: readonly InputModality[];
}

/** 按 id 和展示名做不区分大小写的包含匹配；空查询返回全部。 */
export function filterPickerModels(models: readonly PickerModel[], query: string): PickerModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((model) => model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle));
}

export interface ModelPickerElements {
  root: HTMLElement;
  search: HTMLInputElement;
  list: HTMLElement;
  empty: HTMLElement;
  /** Esc 收起列表时恢复焦点的目标元素（如触发按钮）。 */
  trigger?: HTMLElement | null;
}

export interface ModelPicker {
  open(models: readonly PickerModel[], current: string): void;
  close(): void;
  /** 当前输入框的值变了（手填 / 外部切换档案），同步高亮。 */
  syncCurrent(current: string): void;
}

export function createModelPicker(elements: ModelPickerElements, onPick: (id: string) => void): ModelPicker {
  const { root, search, list, empty, trigger } = elements;
  let all: readonly PickerModel[] = [];
  let current = "";
  let restoreTarget: HTMLElement | null = null;

  const closePicker = (restoreFocus: boolean): void => {
    const wasOpen = !root.hidden;
    root.hidden = true;
    document.removeEventListener("keydown", onDocumentKeyDown);
    const target = restoreFocus && wasOpen ? (trigger ?? restoreTarget) : null;
    restoreTarget = null;
    if (target?.isConnected) target.focus();
  };

  const handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || root.hidden || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    closePicker(true);
  };

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (!root.isConnected) {
      document.removeEventListener("keydown", onDocumentKeyDown);
      return;
    }
    handleEscape(event);
  }

  const render = (): void => {
    const visible = filterPickerModels(all, search.value);
    list.replaceChildren();
    for (const model of visible) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-picker__item";
      item.dataset.modelId = model.id;
      item.setAttribute("role", "option");
      const selected = model.id === current;
      item.setAttribute("aria-selected", String(selected));
      if (selected) item.classList.add("is-current");
      const id = document.createElement("span");
      id.className = "model-picker__id";
      id.textContent = model.id;
      item.appendChild(id);
      if (model.name) {
        const label = document.createElement("span");
        label.className = "model-picker__name";
        label.textContent = model.name;
        item.appendChild(label);
      }
      item.title = model.name ? `${model.id} · ${model.name}` : model.id;
      list.appendChild(item);
    }
    empty.hidden = visible.length > 0;
  };

  list.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-model-id]");
    if (!item?.dataset.modelId) return;
    current = item.dataset.modelId;
    onPick(current);
    render();
  });
  root.addEventListener("keydown", handleEscape);
  trigger?.addEventListener("keydown", handleEscape);
  search.addEventListener("input", render);
  // 搜索框里回车 = 选第一项，省得再用鼠标；Esc = 收起列表并还原焦点。
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      handleEscape(event);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    list.querySelector<HTMLElement>("[data-model-id]")?.click();
  });

  return {
    open(models, value) {
      if (root.hidden) {
        const active = document.activeElement;
        restoreTarget = active instanceof HTMLElement && !root.contains(active) ? active : null;
      }
      all = models;
      current = value;
      search.value = "";
      root.hidden = false;
      document.addEventListener("keydown", onDocumentKeyDown);
      render();
    },
    close() {
      closePicker(false);
    },
    syncCurrent(value) {
      current = value;
      if (!root.hidden) render();
    },
  };
}
