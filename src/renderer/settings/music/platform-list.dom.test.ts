// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function musicPage(): Document {
  const html = readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("音乐工具入口", () => {
  it("是一张带开关的工具卡，和天气、邮件等卡片一致", () => {
    const card = musicPage().getElementById("plugin-music-card");
    expect(card?.classList.contains("plugin-card")).toBe(true);
    expect(card?.querySelector('.plugin-switch input[type="checkbox"]#plugin-music-enabled')).not.toBeNull();
    expect(card?.querySelector("h2")?.textContent?.trim()).toBe("音乐工具");
  });

  it("仍可从卡片进入 QQ Music 的状态与控制面板", () => {
    const page = musicPage();
    expect(page.querySelector("#plugin-music-card #music-platform-qq")).not.toBeNull();
    expect(page.getElementById("music-panel")).not.toBeNull();
  });
});
