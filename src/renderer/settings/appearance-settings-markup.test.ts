import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, test, expect } from "vitest";

const page = new JSDOM(readFileSync(resolve(__dirname, "index.html"), "utf8")).window.document;
function region(id: string): HTMLFormElement {
  const node = page.querySelector<HTMLFormElement>(`form#${id}`);
  expect(node, `settings form ${id}`).not.toBeNull();
  return node!;
}
const appearance = region("appearance-form");
const preferences = region("preferences-form");
const hasControls = (form: Element, names: string[]) => names.forEach(name => expect(form.querySelector(`[id="${name}"]`), name).not.toBeNull());
const lacksControls = (form: Element, names: string[]) => names.forEach(name => expect(form.querySelector(`[id="${name}"]`), name).toBeNull());

describe("settings navigation and ownership", () => {
  test("Firefly and appearance have entries while General keeps an SVG icon and its translated title", () => {
    expect(page.querySelector('[data-section="firefly"]')).not.toBeNull();
    expect(region("firefly-panel").dataset.panel).toBe("firefly");
    hasControls(region("firefly-panel"), ["firefly-save-status"]);
    expect(page.querySelector('[data-section="appearance"]')).not.toBeNull();
    const general = page.querySelector('[data-section="general"]')!;
    expect(general.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(general.firstElementChild?.querySelector("svg.nav-item__icon")).not.toBeNull();
    expect(page.body.textContent).toContain("通用设置");
  });
  test("pet controls belong to Appearance and current conversation switches belong to Preferences", () => {
    const petIds = ["pet-always-on-top", "pet-visible", "pet-zoom"];
    hasControls(appearance, petIds);
    lacksControls(region("general-form"), petIds);
    hasControls(preferences, ["segmented-chat-enabled", "proactive-chat-select", "chat-social-context-enabled"]);
    lacksControls(preferences, ["custom-style-sampling-btn", "custom-style-prompt-btn", "default-chat-mode-select", "mobile-message-segmentation-select"]);
    expect(preferences.textContent).toContain("聊天上下文增强");
    const capsule = preferences.querySelector("#chat-social-context-enabled")?.closest(".switch");
    expect(capsule?.querySelector(".switch__track")).not.toBeNull();
    expect(capsule?.querySelector(".switch__thumb")).not.toBeNull();
  });
});

describe("appearance choices and immediate application", () => {
  test("implemented groups contain no unavailable labels or controls", () => {
    const copy = appearance.textContent ?? "";
    ["主题", "自定义", "字体", "高级", "流萤桌宠", "修改后自动应用"].forEach(text => expect(copy).toContain(text));
    ["界面颜色", "个性化", "SOON", "单窗口", "白调", "窗口圆角", "保存外观设置"].forEach(text => expect(copy).not.toContain(text));
    expect(appearance.querySelector(".appearance-placeholder, #assistant-bubble-enabled")).toBeNull();
    expect(page.documentElement.outerHTML).not.toContain("window-corner-radius");
  });
  test("two theme tiles default to Pearl White and only the Firefly icon is offered", () => {
    hasControls(appearance, ["ui-theme-select", "ui-icon-select"]);
    const themes = [...appearance.querySelectorAll<HTMLElement>(".appearance-theme-option")];
    expect(themes).toHaveLength(2);
    expect(themes.map(tile => tile.dataset.value)).toEqual(expect.arrayContaining(["pearl-white", "firefly-dark"]));
    expect(appearance.querySelector('.appearance-theme-option.is-active')?.getAttribute("data-value")).toBe("pearl-white");
    expect(appearance.querySelector('[data-icon="firefly"]')).not.toBeNull();
    expect(appearance.querySelector('[data-icon="classic"], [data-theme="classic"], [data-theme="pearl-white"], [data-theme="polished-pink"]')).toBeNull();
  });
  test("font import and reset accompany the system and custom font options", () => {
    hasControls(appearance, ["ui-font-select", "ui-font-custom-option", "ui-font-import", "ui-font-reset"]);
    expect(appearance.querySelector('[value="default"]')).not.toBeNull();
  });
  test("advanced font sizes retain numeric ranges and spacing order", () => {
    const advanced = appearance.querySelector<HTMLDetailsElement>("details#appearance-advanced.appearance-advanced")!;
    expect(advanced).not.toBeNull();
    expect(advanced.open).toBe(false);
    const limits = [["ui", "12", "20"], ["chat", "12", "22"], ["code", "11", "20"]];
    for (const [kind, minimum, maximum] of limits) {
      const field = advanced.querySelector<HTMLInputElement>(`#${kind}-font-size-input`)!;
      expect([field.type, field.min, field.max]).toEqual(["number", minimum, maximum]);
    }
    const line = appearance.querySelector("#chat-line-height")!;
    const paragraph = appearance.querySelector("#chat-para-spacing")!;
    expect(line.compareDocumentPosition(paragraph) & 4).toBe(4);
  });
  test("custom colors pair three swatches with editable hex fields and a card switch", () => {
    expect(appearance.querySelectorAll(".ui-color-pill")).toHaveLength(3);
    for (const role of ["accent", "background", "foreground"]) {
      const dot = appearance.querySelector<HTMLInputElement>(`#ui-color-${role}`)!;
      const hex = appearance.querySelector<HTMLInputElement>(`#ui-color-${role}-hex`)!;
      expect([dot.type, dot.className]).toEqual(["color", "ui-color-dot"]);
      expect([hex.type, hex.className]).toEqual(["text", "ui-color-hex"]);
    }
    hasControls(appearance, ["ui-colors-enabled", "ui-colors-reset", "ui-colors-status"]);
    expect(appearance.querySelector("#ui-colors-enabled")?.closest("label.setting-row")?.querySelector(".switch__track")).not.toBeNull();
  });
});
