// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { DEFAULT_CHAT_APPEARANCE } from "../../../shared/chat-appearance";
import { bindAppearanceAdvanced } from "./advanced";

it("saves each advanced choice at once, applies it to the window, and resets everything", async () => {
  document.body.innerHTML = `<details open><summary>高级<button id="appearance-reset" type="button">重置</button></summary>
    <div id="reduce-motion"><button data-value="system"></button><button data-value="on"></button><button data-value="off"></button></div>
    <div id="diff-markers"><button data-value="color"></button><button data-value="signs"></button></div>
    <select id="code-font-select"><option value="system"></option><option value="jetbrains"></option></select>
    <input id="full-width-chat" type="checkbox"><input id="pointer-cursor" type="checkbox"><input id="smart-punctuation" type="checkbox"></details>`;
  const save = vi.fn(async () => {});
  const controls = bindAppearanceAdvanced(document.body, save);
  controls.render({ ...DEFAULT_CHAT_APPEARANCE });

  document.querySelector<HTMLButtonElement>('#reduce-motion [data-value="on"]')!.click();
  expect(save).toHaveBeenLastCalledWith({ reduceMotion: "on" });
  expect(document.documentElement.dataset.reduceMotion).toBe("on");
  expect(document.querySelector('#reduce-motion [data-value="on"]')!.classList.contains("is-active")).toBe(true);

  const fullWidth = document.querySelector<HTMLInputElement>("#full-width-chat")!;
  fullWidth.checked = true; fullWidth.dispatchEvent(new Event("change"));
  expect(save).toHaveBeenLastCalledWith({ fullWidthChat: true });
  expect(document.documentElement.hasAttribute("data-full-width-chat")).toBe(true);

  const font = document.querySelector<HTMLSelectElement>("#code-font-select")!;
  font.value = "jetbrains"; font.dispatchEvent(new Event("change"));
  expect(document.documentElement.style.getPropertyValue("--rb-font-mono")).toContain("JetBrains Mono");

  const details = document.querySelector("details")!;
  document.querySelector<HTMLButtonElement>("#appearance-reset")!.click();
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_CHAT_APPEARANCE });
  expect(details.open).toBe(true);
  expect(document.documentElement.dataset.reduceMotion).toBeUndefined();
  expect(document.documentElement.hasAttribute("data-full-width-chat")).toBe(false);
});

it("picks a code theme for each of light and dark, repaints its preview, and sets the chat's code colours", () => {
  document.body.innerHTML = `
    <select id="code-theme-light"><option value="firefly"></option><option value="github"></option></select>
    <div id="code-theme-light-preview"></div>
    <select id="code-theme-dark"><option value="firefly"></option><option value="dracula"></option></select>
    <div id="code-theme-dark-preview"></div>`;
  const save = vi.fn(async () => {});
  const controls = bindAppearanceAdvanced(document.body, save);
  controls.render({ ...DEFAULT_CHAT_APPEARANCE });
  const darkPreview = document.querySelector<HTMLElement>("#code-theme-dark-preview")!;
  expect(darkPreview.querySelectorAll(".code-theme-preview__line")).toHaveLength(4);
  expect(darkPreview.querySelectorAll(".is-add, .is-remove")).toHaveLength(2);
  // Firefly keeps the window's own code surface in the chat.
  expect(document.documentElement.hasAttribute("data-code-dark-surface")).toBe(false);

  const dark = document.querySelector<HTMLSelectElement>("#code-theme-dark")!;
  dark.value = "dracula"; dark.dispatchEvent(new Event("change"));
  expect(save).toHaveBeenLastCalledWith({ codeThemeDark: "dracula" });
  expect(darkPreview.dataset.theme).toBe("dracula");
  expect(darkPreview.style.background).toBe("rgb(40, 42, 54)");
  const root = document.documentElement;
  expect(root.style.getPropertyValue("--ff-code-dark-keyword")).toBe("#ff79c6");
  expect(root.style.getPropertyValue("--ff-code-dark-background")).toBe("#282a36");
  expect(root.hasAttribute("data-code-dark-surface")).toBe(true);
  // The light choice is untouched.
  expect(root.style.getPropertyValue("--ff-code-light-keyword")).toBe("#a626a4");
  expect(root.hasAttribute("data-code-light-surface")).toBe(false);
});
