// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { choiceOf, createInputModalitiesPanel, declarationOf, type InputModalitiesPanel } from "./input-modalities";
import { setLocale, t } from "../i18n";
import type { InputModalityResolution } from "../../../shared/input-modalities";

const CONTROL = `
  <div id="select" role="radiogroup">
    <button type="button" class="option-block is-active" data-value="auto" aria-pressed="true">自动</button>
    <button type="button" class="option-block" data-value="image" aria-pressed="false">图片</button>
    <button type="button" class="option-block" data-value="text" aria-pressed="false">仅文本</button>
  </div>
  <span id="hint"></span>`;

interface Harness {
  panel: InputModalitiesPanel;
  select: HTMLElement;
  hint: HTMLElement;
  onChange: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  setModel(value: string): void;
  press(value: "auto" | "image" | "text"): void;
  pressed(): string | undefined;
}

function harness(resolve?: (input: unknown) => Promise<InputModalityResolution | undefined>): Harness {
  document.body.innerHTML = CONTROL;
  const select = document.getElementById("select")!;
  const hint = document.getElementById("hint")!;
  let model = "";
  const onChange = vi.fn();
  const resolveSpy = vi.fn(resolve ?? (async (input: unknown): Promise<InputModalityResolution> => {
    const { inputModalities } = input as { inputModalities?: string[] };
    return { image: inputModalities?.includes("image") ?? false, source: "unknown" };
  }));
  const panel = createInputModalitiesPanel({ select, hint }, {
    getProvider: () => "自定义",
    getModel: () => model.trim(),
    resolve: resolveSpy as never,
    t: (key) => t(key),
    onChange,
  });
  return {
    panel,
    select,
    hint,
    onChange,
    resolve: resolveSpy,
    setModel(value) {
      model = value;
    },
    press(value) {
      select.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!.click();
    },
    pressed() {
      return select.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.dataset.value;
    },
  };
}

beforeEach(() => setLocale("zh-CN"));

describe("声明与三态的纯函数", () => {
  it("只有用户覆盖才算“图片 / 仅文本”，厂商记录与未声明都算“自动”", () => {
    expect(choiceOf(undefined)).toBe("auto");
    expect(choiceOf({ modalities: ["text", "image"], source: "vendor-api" })).toBe("auto");
    expect(choiceOf({ modalities: ["text", "image"], source: "user" })).toBe("image");
    expect(choiceOf({ modalities: ["text"], source: "user" })).toBe("text");
  });

  it("档案字段转声明：空或缺失 = 未声明；缺来源按用户覆盖", () => {
    expect(declarationOf({})).toBeUndefined();
    expect(declarationOf({ inputModalities: [] })).toBeUndefined();
    expect(declarationOf({ inputModalities: ["text"], inputModalitiesSource: "vendor-api" })).toEqual({ modalities: ["text"], source: "vendor-api" });
    expect(declarationOf({ inputModalities: ["text", "image"] })).toEqual({ modalities: ["text", "image"], source: "user" });
  });
});

describe("输入类型控件", () => {
  it("点选图片或仅文本记为用户覆盖，并通知草稿；选中态与保存声明一致", async () => {
    const h = harness();
    h.setModel("brand-new");
    h.panel.modelChanged();
    h.press("image");
    expect(h.pressed()).toBe("image");
    expect(h.panel.declared()).toEqual({ modalities: ["text", "image"], source: "user" });
    expect(h.onChange).toHaveBeenCalledTimes(1);
    h.press("text");
    expect(h.panel.declared()).toEqual({ modalities: ["text"], source: "user" });
    expect(h.pressed()).toBe("text");
  });

  it("选自动撤销覆盖；没有厂商记录时回到未声明", () => {
    const h = harness();
    h.setModel("brand-new");
    h.panel.load(undefined, "brand-new");
    h.press("image");
    h.press("auto");
    expect(h.panel.declared()).toBeUndefined();
    expect(h.pressed()).toBe("auto");
  });

  it("厂商接口记录按列表给出的模态生效；手动覆盖压过它；选自动时恢复为与当前型号匹配的记录", () => {
    const h = harness();
    h.setModel("model-a");
    h.panel.modelChanged();
    h.panel.picked("model-a", ["text"]);
    expect(h.panel.declared()).toEqual({ modalities: ["text"], source: "vendor-api" });
    expect(h.pressed()).toBe("auto");

    h.press("image");
    h.panel.picked("model-a", ["text"]);
    expect(h.panel.declared()).toEqual({ modalities: ["text", "image"], source: "user" });

    h.press("auto");
    expect(h.panel.declared()).toEqual({ modalities: ["text"], source: "vendor-api" });
  });

  it("厂商没说模态的型号不带旧记录：选中后未声明，覆盖仍保留", () => {
    const h = harness();
    h.setModel("model-a");
    h.panel.picked("model-a", ["text", "image"]);
    expect(h.panel.declared()?.source).toBe("vendor-api");
    h.setModel("model-b");
    h.panel.picked("model-b", undefined);
    expect(h.panel.declared()).toBeUndefined();
  });

  it("型号一变，厂商记录和它带来的声明一起作废；用户覆盖保留", () => {
    const h = harness();
    h.setModel("model-a");
    h.panel.picked("model-a", ["text", "image"]);
    h.setModel("model-b");
    h.panel.modelChanged();
    expect(h.panel.declared()).toBeUndefined();
    expect(h.pressed()).toBe("auto");

    h.press("text");
    h.setModel("model-c");
    h.panel.modelChanged();
    expect(h.panel.declared()).toEqual({ modalities: ["text"], source: "user" });
    expect(h.pressed()).toBe("text");
  });

  it("载入档案时已保存的厂商声明同时成为该型号的记录，覆盖之后仍可“自动”恢复", () => {
    const h = harness();
    h.setModel("saved-model");
    h.panel.load({ modalities: ["text", "image"], source: "vendor-api" }, "saved-model");
    expect(h.pressed()).toBe("auto");
    h.press("text");
    expect(h.panel.declared()).toEqual({ modalities: ["text"], source: "user" });
    h.press("auto");
    expect(h.panel.declared()).toEqual({ modalities: ["text", "image"], source: "vendor-api" });
  });
});

describe("生效结果说明", () => {
  it("说明由主进程的生效结果给出：支持图片 · 手动设置", async () => {
    const h = harness(async () => ({ image: true, source: "declared-user" }));
    h.setModel("brand-new");
    h.panel.load({ modalities: ["text", "image"], source: "user" }, "brand-new");
    await vi.waitFor(() => expect(h.hint.textContent).toBe("支持图片 · 手动设置"));
    expect(h.resolve).toHaveBeenLastCalledWith({
      provider: "自定义",
      model: "brand-new",
      inputModalities: ["text", "image"],
      inputModalitiesSource: "user",
    });
  });

  it("未识别的型号说明为仅文本，并提示可以手动设为图片", async () => {
    const h = harness(async () => ({ image: false, source: "unknown" }));
    h.setModel("mystery");
    h.panel.load(undefined, "mystery");
    await vi.waitFor(() => expect(h.hint.textContent).toBe("仅文本 · 未能识别（可手动设为“图片”）"));
  });

  it("厂商记录与内置目录各自的来源文案", async () => {
    const answers: InputModalityResolution[] = [
      { image: true, source: "declared-vendor-api" },
      { image: true, source: "catalog" },
    ];
    const h = harness(async () => answers.shift());
    h.setModel("m");
    h.panel.picked("m", ["text", "image"]);
    await vi.waitFor(() => expect(h.hint.textContent).toBe("支持图片 · 来自厂商接口"));
    h.panel.modelChanged();
    await vi.waitFor(() => expect(h.hint.textContent).toBe("支持图片 · 来自内置目录"));
  });

  it("较早的回应晚到时不覆盖更新的结果", async () => {
    let releaseFirst: (value: InputModalityResolution) => void = () => {};
    const answers = [
      new Promise<InputModalityResolution>((resolve) => { releaseFirst = resolve; }),
      Promise.resolve<InputModalityResolution>({ image: false, source: "unknown" }),
    ];
    const h = harness(async () => answers.shift());
    h.setModel("first");
    h.panel.load(undefined, "first");
    h.setModel("second");
    h.panel.modelChanged();
    await vi.waitFor(() => expect(h.hint.textContent).toBe("仅文本 · 未能识别（可手动设为“图片”）"));
    releaseFirst({ image: true, source: "catalog" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.hint.textContent).toBe("仅文本 · 未能识别（可手动设为“图片”）");
  });

  it("主进程不可用时说明留空，三态照常工作", async () => {
    const h = harness(async () => undefined);
    h.setModel("m");
    h.panel.load({ modalities: ["text"], source: "user" }, "m");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.resolve).toHaveBeenCalled();
    expect(h.hint.textContent).toBe("");
    expect(h.pressed()).toBe("text");
  });
});
