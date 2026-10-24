import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { BUILT_IN_STICKER_DESCRIPTIONS, BUILT_IN_STICKER_FILES } from "./stickers/sticker-descriptions";
import { TASK_CHARACTERS } from "../shared/task-characters";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

it("keeps the twelve avatar mappings and excludes source persona from runtime prompts", () => {
  expect(TASK_CHARACTERS).toHaveLength(12);
  for (const character of TASK_CHARACTERS) {
    expect(fs.existsSync(path.join(root, "src/renderer/assets/task-portraits", character.assetFileName))).toBe(true);
    expect(read("src/renderer/react/character-portraits.ts")).toContain(`assets/task-portraits/${character.assetFileName}`);
  }
  expect(fs.existsSync(path.join(root, "prompts/source-persona/firefly.yaml"))).toBe(false);
});

it("indexes only current Firefly descriptions and resources", () => {
  expect(Object.keys(BUILT_IN_STICKER_DESCRIPTIONS)).toHaveLength(29);
  for (const file of Object.values(BUILT_IN_STICKER_FILES)) expect(fs.existsSync(path.join(root, "src/renderer/public/stickers", file))).toBe(true);
});

it("exposes only current Window and SDK contracts", () => {
  expect(read("src/preload/index.ts")).not.toContain("LEGACY_WINDOW_API_NAMES");
  expect(read("packages/plugin-sdk/src/index.ts")).not.toContain('"./legacy"');
  expect(fs.existsSync(path.join(root, "examples/system-status-0.1.0.zip"))).toBe(false);
  expect(JSON.parse(read("examples/system-status/manifest.json")).author).toBe("wu02");
});

it("keeps Firefly source licensing separate from model and third-party terms", () => {
  expect(read("MODEL_LICENSE.md")).toContain("src/renderer/public/models/firefly/");
  expect(read("MODEL_LICENSE.md")).not.toContain("unrestricted permission");
  const notices = read("THIRD_PARTY_NOTICES.md");
  expect(notices).toContain("https://github.com/deepseek-ai/deepseek-harness");
  expect(notices).toContain("https://www.live2d.com/eula/");
  expect(notices).not.toContain("Existing upstream contributions are recorded");
  const license = read("LICENSE");
  expect(license).toMatch(/^MIT License/);
  expect(license.match(/^Copyright .+$/gm)).toEqual(["Copyright (c) 2026 Firefly-0423"]);
  expect(license).toContain("Permission is hereby granted, free of charge");
});

it("has valid file targets in the license and readme links", () => {
  for (const file of ["README.md", "README.en.md", "THIRD_PARTY_NOTICES.md", "MODEL_LICENSE.md"]) {
    for (const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split("#")[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      expect(fs.existsSync(path.resolve(root, path.dirname(file), decodeURIComponent(link))), `${file}: ${link}`).toBe(true);
    }
  }
});

it("keeps maintenance tools at their current paths and excludes unused installer artwork", () => {
  expect(fs.existsSync(path.join(root, "build/installer.nsh"))).toBe(true);
  expect(fs.existsSync(path.join(root, "build/installer-sidebar.bmp"))).toBe(false);
  expect(read("electron-builder.yml")).toContain("include: build/installer.nsh");
  expect(read("electron-builder.yml")).not.toContain("installerSidebar");
  for (const file of ["loading.png", "icons/mimi.png", "icons/sticker-picker.png", "context-usage/alert.png", "feeling/开心.png"]) {
    expect(fs.existsSync(path.join(root, "src/renderer/public", file)), file).toBe(false);
  }
  for (const file of ["scripts/packaging/upstream-skills/fetch_skills.py", "scripts/packaging/upstream-skills/sources.json", "scripts/verify/sandbox-runtime/check-status.mjs"]) {
    expect(fs.existsSync(path.join(root, file)), file).toBe(true);
  }
  for (const file of ["README.md", "README.en.md", "DEVELOPMENT.md", "scripts/README.md", "resources/README.md", "examples/README.md"]) {
    expect(read(file), file).not.toMatch(/docs\/refactor\/|docs\/migration\/|docs\/internal-issue\/|poc\/srt|tools\/firefly-upstream-fetch/);
  }
  expect(read("scripts/perf/chat-renderer-baseline.mjs")).toContain("output/perf/baseline-report.json");
});
