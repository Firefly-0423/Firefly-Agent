import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { test, expect } from "vitest";

const settingsPage = new JSDOM(readFileSync(resolve(__dirname, "index.html"), "utf8")).window.document;

test("advanced runtime controls exclude every retired timeout and budget field", () => {
  const panels = [...settingsPage.querySelectorAll('form[data-panel="api-advanced"]')];
  expect(panels.length).toBeGreaterThan(0);
  const ids = panels.flatMap(panel => [...panel.querySelectorAll("[id]")].map(node => node.id));
  expect(ids).toEqual(expect.arrayContaining(["model-request-timeout-sec", "timeout-user-choice"]));
  expect(panels.map(panel => panel.textContent).join(" ")).toContain("询问等待时间（秒）");
  const retired = "per-call-timeout-sec timeout-profile-per-attempt max-iterations max-replans max-refresh action-gate-repair-budget-sec timeout-profile-total-budget timeout-profile-remaining timeout-summary timeout-memory-judge timeout-vision chat-request-timeout-sec".split(" ");
  expect(ids.filter(id => retired.includes(id))).toEqual([]);
});

test("chat-owned Skills have no settings navigation, panel or host", () => {
  expect(settingsPage.querySelector('[data-section="skills"], [data-panel="skills"], #skills-panel')).toBeNull();
});
