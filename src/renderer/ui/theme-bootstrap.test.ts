import { existsSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { it, expect, describe } from "vitest";

describe("Initial window theme before JavaScript starts", () => {
  it("has no entry document for the retired calling window", () => {
    expect(existsSync(new URL("../call/index.html", import.meta.url))).toEqual(false);
  });
  for (const entry of ["settings/index.html", "react/index.html", "index.html", "sticker-manager/index.html", "sidebar/index.html"]) {
    it(`loads pearl white and the required stylesheet suffix in ${entry}`, () => {
      const markup = readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
      const document = new JSDOM(markup).window.document;
      expect(document.documentElement.dataset.uiTheme).toEqual("pearl-white");
      const urls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'), link => link.getAttribute("href")!);
      const expected = entry.startsWith("settings/")
        ? ["../ui/theme.css", "../ui/glow.css", "./settings-layout.css", "./settings-system.css", "./settings-api.css", "./settings-controls.css"]
        : ["ui/theme.css", "ui/glow.css"];
      const actual = urls.slice(-expected.length).map(url => entry.startsWith("settings/") ? url : url.replace(/^.*ui\//, "ui/"));
      expect(actual).toStrictEqual(expected);
    });
  }
});
