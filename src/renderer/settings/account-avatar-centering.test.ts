// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), "src/renderer/settings", name), "utf8");

describe("account card avatar", () => {
  beforeAll(() => {
    const style = document.createElement("style");
    style.textContent = `${read("settings.css")}\n${read("settings-system.css")}`;
    document.head.appendChild(style);
    const html = read("index.html");
    const card = html.match(/<div class="setting-row account-card"[\s\S]*?<span class="account-card__avatar" aria-hidden="true">[\s\S]*?<\/span>/)
      ?? html.match(/<div class="[^"]*account-card[^"]*"[\s\S]*?<span class="account-card__avatar" aria-hidden="true">[\s\S]*?<\/span>/);
    if (!card) throw new Error("account card markup not found");
    document.body.innerHTML = `<div class="setting-row"><div class="account-card__identity">${card[0].slice(card[0].indexOf('<span class="account-card__avatar"'))}</div></div>`;
  });

  it("centres its placeholder icon: the circle stays a grid even inside a setting row", () => {
    const avatar = document.querySelector<HTMLElement>(".account-card__avatar")!;

    expect(getComputedStyle(avatar).display).toBe("grid");
  });
});
