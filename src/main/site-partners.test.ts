import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SPECIALIST_AGENTS } from "../shared/specialist-agents";
import { PARTNERS_EN } from "../../site/partners";

const root = resolve(__dirname, "../..");

describe("promo site partners", () => {
  it("has a portrait and English text for every partner the app ships", () => {
    for (const agent of SPECIALIST_AGENTS) {
      expect(existsSync(resolve(root, `site/partners/${agent.id}.webp`)), agent.id).toBe(true);
      expect(PARTNERS_EN[agent.id]?.every(text => text.trim().length > 0), agent.id).toBe(true);
    }
    expect(Object.keys(PARTNERS_EN).sort()).toEqual(SPECIALIST_AGENTS.map(agent => agent.id).sort());
  });

  it("counts the partners correctly in the section heading, in both languages", () => {
    const count = String(SPECIALIST_AGENTS.length);
    const html = readFileSync(resolve(root, "site/index.html"), "utf8");
    const main = readFileSync(resolve(root, "site/main.ts"), "utf8");
    expect(html).toMatch(new RegExp(`data-i18n="team.title">[^<]*\\b${count} 位伙伴<`));
    expect(main).toMatch(new RegExp(`"team.title": "[^"]*\\b${count} partners"`));
  });
});
