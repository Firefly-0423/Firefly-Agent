import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BUILT_IN_STICKER_DESCRIPTIONS, BUILT_IN_STICKER_FILES } from "./knowledge/stickers/sticker-descriptions";
import { TASK_CHARACTERS } from "../shared/task-characters";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function collectPreloadSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectPreloadSourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec|d)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

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
  const preloadDir = path.join(root, "src/preload");
  expect(fs.existsSync(path.join(preloadDir, "index.ts"))).toBe(true);
  const preloadFiles = collectPreloadSourceFiles(preloadDir);
  expect(preloadFiles.map((file) => path.relative(root, file).split(path.sep).join("/"))).toContain("src/preload/index.ts");
  for (const file of preloadFiles) {
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    expect(fs.readFileSync(file, "utf8"), relativePath).not.toContain("LEGACY_WINDOW_API_NAMES");
  }
  expect(read("plugin-sdk/src/index.ts")).not.toContain('"./legacy"');
  expect(fs.existsSync(path.join(root, "examples/system-status-0.1.0.zip"))).toBe(false);
  expect(JSON.parse(read("examples/system-status/manifest.json")).author).toBe("wu02");
});

it("recursively scans preload subdirectories for non-test TypeScript modules", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "structure-cleanup-preload-"));
  try {
    fs.mkdirSync(path.join(tempDir, "settings"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "index.ts"), "export {};", "utf8");
    fs.writeFileSync(path.join(tempDir, "settings/channels.ts"), "export {};", "utf8");
    fs.writeFileSync(path.join(tempDir, "settings/channels.test.ts"), "LEGACY_WINDOW_API_NAMES", "utf8");
    fs.writeFileSync(path.join(tempDir, "settings/channels.d.ts"), "LEGACY_WINDOW_API_NAMES", "utf8");

    const files = collectPreloadSourceFiles(tempDir)
      .map((file) => path.relative(tempDir, file).split(path.sep).join("/"))
      .sort();
    expect(files).toEqual(["index.ts", "settings/channels.ts"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  for (const file of ["README.md", "README.en.md", "docs/contributing/development.md", "scripts/README.md", "resources/README.md", "examples/README.md"]) {
    expect(read(file), file).not.toMatch(/docs\/refactor\/|docs\/migration\/|docs\/internal-issue\/|poc\/srt|tools\/firefly-upstream-fetch/);
  }
  expect(read("scripts/perf/chat-renderer-baseline.mjs")).toContain("output/perf/baseline-report.json");
});
