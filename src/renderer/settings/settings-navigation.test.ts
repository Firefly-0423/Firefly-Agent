// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bindSettingsNavigation, resolveSettingsSection, updateSettingsNavigation } from "./shared/navigation";

const html = fs.readFileSync(path.resolve("src/renderer/settings/index.html"), "utf8");

describe("settings category navigation", () => {
  beforeEach(() => { document.body.innerHTML = html; });

  it("starts with General and falls back to it for removed or unknown categories", () => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
    expect(buttons[0].dataset.section).toBe("general");
    expect(resolveSettingsSection("", buttons)).toBe("general");
    expect(resolveSettingsSection("moments", buttons)).toBe("general");
    expect(resolveSettingsSection("api", buttons)).toBe("api");
  });

  it("moves keyboard focus and opens the next category with ArrowDown", () => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
    let selected = "general";
    bindSettingsNavigation(buttons, section => { selected = section; updateSettingsNavigation(buttons, section); });
    updateSettingsNavigation(buttons, "general");
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[1]);
    expect(selected).toBe(buttons[1].dataset.section);
    expect(buttons[1].getAttribute("aria-current")).toBe("page");
    expect(buttons[0].hasAttribute("aria-current")).toBe(false);
  });

  it("keeps existing nested tool panels reachable even without their own category button", () => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
    const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"), panel => panel.dataset.panel!);
    expect(panels).toContain("music");
    expect(resolveSettingsSection("music", buttons, panels)).toBe("music");
  });

  it("supports Home, End and wraparound without changing focus on external selection", () => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
    bindSettingsNavigation(buttons, section => updateSettingsNavigation(buttons, section));
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    expect(document.activeElement).toBe(buttons.at(-1));
    buttons.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", cancelable: true }));
    expect(document.activeElement).toBe(buttons.at(-1));
    updateSettingsNavigation(buttons, "api");
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it("removes Moments preferences while retaining the real preferences form and save feedback", () => {
    const preferences = document.getElementById("preferences-form")!;
    expect(preferences.querySelector('[id*="moments"]')).toBeNull();
    expect(preferences.querySelector('[type="submit"]')).not.toBeNull();
    expect(preferences.querySelector('#preferences-save-status')).not.toBeNull();
    expect(preferences.querySelector('#chat-social-context-enabled')).not.toBeNull();
  });
});


it("retains every first-level settings destination, with MCP servers and the sub-agents as their own entries", () => {
  document.body.innerHTML = html;
  expect([...document.querySelectorAll<HTMLButtonElement>('.nav-item')].map(button => button.dataset.section)).toEqual(["general", "appearance", "preferences", "user", "api", "api-advanced", "firefly", "subagents", "memory", "plugins", "mcp", "channels", "asr", "usage", "disclaimer"]);
});
