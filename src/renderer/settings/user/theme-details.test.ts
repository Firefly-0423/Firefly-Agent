import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsMarkup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const settingsStyles = readFileSync(new URL("../settings.css", import.meta.url), "utf8");
const themeStyles = readFileSync(new URL("../../ui/theme.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const translations = JSON.parse(readFileSync(new URL("../i18n/zh-CN.json", import.meta.url), "utf8")) as {
  settings: { panel: { user: { callPrefPlaceholder: string } } };
};

describe("Firefly settings theme and address", () => {
  it("shows the same call-preference example in markup and translation", () => {
    expect(settingsMarkup).toContain('id="user-call-pref" placeholder="例如：开拓者"');
    expect(translations.settings.panel.user.callPrefPlaceholder).toBe("例如：开拓者");
  });

  it("uses one accent focus and hover treatment for shared setting fields", () => {
    expect(themeStyles).toContain('[data-ui-theme="pearl-white"] .tts-field input:hover:not(:disabled)');
    expect(themeStyles).toContain('[data-ui-theme="pearl-white"] .tts-field input:focus');
    expect(themeStyles).toContain('border-color: var(--rb-pink-500);\n  box-shadow: 0 0 0 3px rgba(68, 70, 79, 0.18);');
    expect(settingsStyles).not.toContain("255, 182, 220");
    expect(settingsStyles).not.toContain("255, 192, 230");
  });
});
