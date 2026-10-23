// API 设置页“输入类型”：三态控件（自动 / 图片 / 仅文本）与当前生效结果说明。
//
// 档案只存一份显式声明（inputModalities + 来源）：用户覆盖（user）或厂商接口记录（vendor-api）。
// - 用户覆盖永远压过厂商接口记录；选“自动”= 撤销覆盖，有与当前型号匹配的厂商记录则恢复为它。
// - 厂商记录只属于它当时对应的型号 id：型号一变即作废，避免旧型号的能力串到新型号上。
// - 生效结果（能否直发图片、依据）只由主进程 resolveInputModalities 给出；这里只管状态与展示。

import type { InputModality, InputModalityResolution, InputModalitySource } from "../../../shared/input-modalities";

export type InputChoice = "auto" | "image" | "text";

/** 档案里的显式声明；undefined = 自动（内置目录 / 未知回落）。 */
export interface InputDeclaration {
  modalities: InputModality[];
  source: InputModalitySource;
}

/** 本次编辑中从厂商接口拿到的型号模态，只对 model 有效。 */
interface VendorRecord {
  model: string;
  modalities: InputModality[];
}

interface PanelState {
  declared?: InputDeclaration;
  vendor?: VendorRecord;
}

const USER_DECLARATIONS: Record<"image" | "text", InputModality[]> = {
  image: ["text", "image"],
  text: ["text"],
};

const SOURCE_KEYS: Record<InputModalityResolution["source"], string> = {
  "declared-user": "settings.providerUi.inputModalities.sourceUser",
  "declared-vendor-api": "settings.providerUi.inputModalities.sourceVendor",
  catalog: "settings.providerUi.inputModalities.sourceCatalog",
  unknown: "settings.providerUi.inputModalities.sourceUnknown",
};

/** 档案字段 → 显式声明；模态为空 = 未声明。来源缺失时按用户覆盖对待（与主进程清洗一致）。 */
export function declarationOf(fields: { inputModalities?: readonly InputModality[]; inputModalitiesSource?: InputModalitySource }): InputDeclaration | undefined {
  if (!fields.inputModalities || fields.inputModalities.length === 0) return undefined;
  return { modalities: [...fields.inputModalities], source: fields.inputModalitiesSource ?? "user" };
}

/** 三态里当前选中哪一个：只有用户覆盖算“图片 / 仅文本”，厂商记录与内置目录都算“自动”。 */
export function choiceOf(declared: InputDeclaration | undefined): InputChoice {
  if (declared?.source !== "user") return "auto";
  return declared.modalities.includes("image") ? "image" : "text";
}

/** 型号 id 变了：厂商记录作废；当前声明若来自厂商记录也一并撤掉，用户覆盖保留。 */
function forModel(state: PanelState, model: string): PanelState {
  if (state.vendor?.model === model) return state;
  return { declared: state.declared?.source === "user" ? state.declared : undefined };
}

function vendorDeclaration(vendor: VendorRecord | undefined): InputDeclaration | undefined {
  return vendor ? { modalities: [...vendor.modalities], source: "vendor-api" } : undefined;
}

/** 点选三态之一：图片 / 仅文本写入用户覆盖；自动撤销覆盖，回到与当前型号匹配的厂商记录（若有）。 */
function chooseState(state: PanelState, choice: InputChoice, model: string): PanelState {
  const current = forModel(state, model);
  if (choice === "auto") return { declared: vendorDeclaration(current.vendor), vendor: current.vendor };
  return { declared: { modalities: [...USER_DECLARATIONS[choice]], source: "user" }, vendor: current.vendor };
}

/** 从厂商列表选中一个型号：记下它的模态。手动覆盖仍然优先，只更新记录。 */
function pickState(state: PanelState, model: string, modalities: readonly InputModality[] | undefined): PanelState {
  const vendor: VendorRecord | undefined = modalities && modalities.length > 0 ? { model, modalities: [...modalities] } : undefined;
  if (state.declared?.source === "user") return { declared: state.declared, vendor };
  return { declared: vendorDeclaration(vendor), vendor };
}

/** 载入档案或新建草稿：整体替换。已保存的厂商声明同时作为该型号的记录，便于之后“自动”恢复。 */
function loadState(declared: InputDeclaration | undefined, model: string): PanelState {
  return {
    declared,
    vendor: declared?.source === "vendor-api" ? { model, modalities: [...declared.modalities] } : undefined,
  };
}

export interface InputModalitiesPanelElements {
  /** 三态分段控件：.option-block 按钮，data-value 为 auto / image / text。 */
  select: HTMLElement;
  /** 当前生效结果说明（“支持图片 · 来自厂商接口”之类）。 */
  hint: HTMLElement;
}

export interface InputModalitiesPanelDeps {
  getProvider(): string;
  /** 当前模型 id（已去首尾空白）。 */
  getModel(): string;
  /** 主进程的生效结果；不可用或失败时返回 undefined。 */
  resolve(input: {
    provider: string;
    model: string;
    inputModalities?: InputModality[];
    inputModalitiesSource?: InputModalitySource;
  }): Promise<InputModalityResolution | undefined>;
  t(key: string): string;
  /** 用户改了三态控件（用于刷新草稿的脏状态）。 */
  onChange(): void;
}

export interface InputModalitiesPanel {
  /** 保存用的显式声明（已按当前型号校正）；undefined = 自动。 */
  declared(): InputDeclaration | undefined;
  /** 载入档案或新建草稿。 */
  load(declared: InputDeclaration | undefined, model: string): void;
  /** 型号 id 变了（手填、从列表选择、切换预设）。 */
  modelChanged(): void;
  /** 从厂商列表选中一个型号；modalities 缺省 = 厂商没说（未知）。 */
  picked(model: string, modalities: readonly InputModality[] | undefined): void;
}

/** 绑定三态控件与说明文字。状态只在本面板内，保存与脏检测通过 declared() 读取。 */
export function createInputModalitiesPanel(elements: InputModalitiesPanelElements, deps: InputModalitiesPanelDeps): InputModalitiesPanel {
  let state: PanelState = {};
  let latest = 0;

  const declaredNow = (): InputDeclaration | undefined => forModel(state, deps.getModel()).declared;

  const refreshHint = async (): Promise<void> => {
    const request = ++latest;
    const declared = declaredNow();
    let result: InputModalityResolution | undefined;
    try {
      result = await deps.resolve({
        provider: deps.getProvider(),
        model: deps.getModel(),
        inputModalities: declared?.modalities,
        inputModalitiesSource: declared?.source,
      });
    } catch {
      result = undefined;
    }
    // 较早发出的请求晚到时不覆盖更新的结果
    if (request !== latest) return;
    elements.hint.textContent = result
      ? `${deps.t(result.image ? "settings.providerUi.inputModalities.stateImage" : "settings.providerUi.inputModalities.stateText")} · ${deps.t(SOURCE_KEYS[result.source])}`
      : "";
  };

  const render = (): void => {
    const choice = choiceOf(declaredNow());
    for (const button of elements.select.querySelectorAll<HTMLButtonElement>(".option-block")) {
      const active = button.dataset.value === choice;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    void refreshHint();
  };

  elements.select.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".option-block");
    const value = button?.dataset.value;
    if (!button || button.disabled || (value !== "auto" && value !== "image" && value !== "text")) return;
    state = chooseState(state, value, deps.getModel());
    render();
    deps.onChange();
  });

  return {
    declared: declaredNow,
    load(declared, model) {
      state = loadState(declared, model);
      render();
    },
    modelChanged() {
      state = forModel(state, deps.getModel());
      render();
    },
    picked(model, modalities) {
      state = pickState(state, model, modalities);
      render();
    },
  };
}
