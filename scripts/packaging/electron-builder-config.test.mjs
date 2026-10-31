import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, access, readdir, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import YAML from "yaml";
import { syntheticHistoryHelper } from "../verify/history-helpers-fixture.mjs";
const require = createRequire(import.meta.url);
const { FileMatcher, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
const { copyDir } = require("builder-util");

const source = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
const installerInclude = await readFile(new URL("../../build/installer.nsh", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
const packageWorkflow = YAML.parse(await readFile(new URL("../../.github/workflows/package-windows.yml", import.meta.url), "utf8"));

test("vendor resources ship canonical directories and legal notices without a ZIP", async context => {
  const config = YAML.parse(source);
  const entries = config.extraResources.filter(entry => entry.from.startsWith("vendor/firefly-skills/"));
  assert.deepEqual(entries.map(entry => entry.from).sort(), [
    "vendor/firefly-skills/LICENSE-NOTICES.md",
    "vendor/firefly-skills/license-provenance.json",
    "vendor/firefly-skills/licenses",
    "vendor/firefly-skills/skills",
    "vendor/firefly-skills/skills-manifest.json",
  ].sort());
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const destination = await mkdtemp(path.join(os.tmpdir(), "firefly-resources-test-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  for (const entry of entries) {
    const matcher = new FileMatcher(path.join(root, entry.from), path.join(destination, path.relative("firefly-skills", entry.to)), value => value, entry.filter);
    await copyFiles([matcher], undefined, false);
  }
  for (const name of ["skills-manifest.json", "LICENSE-NOTICES.md", "license-provenance.json", "skills/xlsx/SKILL.md"])
    await access(path.join(destination, name));
  await assert.rejects(access(path.join(destination, "skills-snapshot.zip")), { code: "ENOENT" });
  for (const key of ["build", "dev", "start", "package:win:dir"])
    assert.ok(!packageJson.scripts[key].includes("prepare:skills"), key);
});

test("extra files deliver four capabilities and nested support content without retired factories", async context => {
  const config = YAML.parse(source);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const destination = await mkdtemp(path.join(os.tmpdir(), "firefly-support-test-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  for (const name of ["skills", "prompts"]) {
    const entry = config.extraFiles.find(entry => entry.from === name);
    assert.equal(entry.to, name);
    const matcher = new FileMatcher(path.join(root, entry.from), path.join(destination, entry.to), value => value, entry.filter);
    await copyFiles([matcher], undefined, false);
  }
  assert.deepEqual((await readdir(path.join(destination, "skills"))).sort(),
    ["diagram", "document-reader-validation", "knowledge-workspace", "plugin-development"]);
  for (const name of [
    "persona-support/original-voice.md", "persona-support/references/boundary.md", "persona-support/LICENSE",
    "workflow-support/plan-mode.md", "workflow-support/work-hygiene.md", "workflow-support/LICENSE",
    "workflow-support/references/coverage-check.md", "workflow-support/references/execution-handoff.md",
    "workflow-support/references/plan-templates.md",
  ]) {
    assert.deepEqual(await readFile(path.join(destination, "prompts", name)), await readFile(path.join(root, "prompts", name)));
  }
});

test("production TypeScript entry sets exclude tests but retain application and bridge entries", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const [config, entry] of [["tsconfig.main.json", "src/main/index.ts"], ["tsconfig.preload.json", "src/preload/index.ts"]]) {
    const location = path.join(root, config);
    const loaded = ts.readConfigFile(location, ts.sys.readFile);
    assert.equal(loaded.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
    assert.deepEqual(parsed.errors, []);
    assert.ok(parsed.fileNames.some(file => path.resolve(file) === path.resolve(root, entry)));
    assert.deepEqual(parsed.fileNames.filter(file => /\.test\.[cm]?tsx?$/.test(file)), [], config);
  }
});

test("the Firefly package identity is consistent and does not publish updates", () => {
  assert.equal(packageJson.name, "firefly-agent");
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.packages[""].name, packageJson.name);
  assert.equal(packageJson.version, "1.1.0");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.match(source, /^appId: com\.serendipitywu02\.firefly$/m);
  assert.match(source, /^productName: Firefly_Agent$/m);
  assert.match(source, /^publish: \[\]$/m);
});

test("the core package excludes retired music components and includes the QQ bridge", () => {
  assert.match(source, /-\s+"!dist\/components\/\*\*\/\*"/);
  assert.match(source, /-\s+"!models\/\*\*\/\*"/);
  assert.doesNotMatch(source, /vendor\/cloud-music-mcp/);
  assert.doesNotMatch(source, /-\s+models\/\*\*\/\*/);
  assert.doesNotMatch(source, /-\s+from: resources\/components/);
  assert.doesNotMatch(source, /-\s+from: resources\/bin\/mpv/);
  assert.match(source, /-\s+from: src\/main\/music\/scripts\/qqmusic_gsmtc\.ps1/);
  assert.match(source, /artifactName:\s+Firefly_Agent-Setup-\$\{version\}\.\$\{ext\}/);
});

test("the assisted installer exposes Firefly setup choices and an uninstall entry", () => {
  assert.match(source, /createDesktopShortcut:\s+false/);
  assert.match(source, /include:\s+build\/installer\.nsh/);
  assert.match(source, /menuCategory:\s+Firefly_Agent/);
});

test("the installer carries upstream and font license notices", () => {
  assert.match(source, /from: LICENSE\s+to: LICENSE/);
  assert.match(source, /from: THIRD_PARTY_NOTICES\.md\s+to: THIRD_PARTY_NOTICES\.md/);
  assert.match(source, /from: node_modules\/katex\/LICENSE\s+to: licenses\/KaTeX-LICENSE/);
  assert.match(source, /from: node_modules\/@fontsource-variable\/noto-sans-sc\/LICENSE\s+to: licenses\/NotoSansSC-OFL\.txt/);
  assert.match(source, /from: node_modules\/@fontsource-variable\/jetbrains-mono\/LICENSE\s+to: licenses\/JetBrainsMono-OFL\.txt/);
});

test("the assisted installer stores launch preferences under the Firefly userData directory", () => {
  assert.match(
    installerInclude,
    /\$APPDATA\\Firefly\\installer-options\.json/,
  );
  assert.doesNotMatch(
    installerInclude,
    /\$APPDATA\\\$\{PRODUCT_FILENAME\}\\installer-options\.json/,
  );
  assert.doesNotMatch(installerInclude, /\$APPDATA\\\$\{APP_PACKAGE_NAME\}\\installer-options\.json/);
});

test("upgrade staging is Firefly-owned rather than sharing Firefly paths", () => {
  assert.match(installerInclude, /\.Firefly\.content-preserve/);
  assert.match(installerInclude, /\.Firefly\.models-preserve/);
});


test("both history helpers ship outside ASAR in resources/bin", async context => {
  const entries = YAML.parse(source).extraResources.filter(entry => entry.from.startsWith("native/target/release/firefly-history-"));
  assert.deepEqual(entries, [
    { from: "native/target/release/firefly-history-read.exe", to: "bin/firefly-history-read.exe" },
    { from: "native/target/release/firefly-history-presence.exe", to: "bin/firefly-history-presence.exe" },
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), "firefly-history-package-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of entries) {
    const helper = path.join(root, entry.from);
    await mkdir(path.dirname(helper), { recursive: true });
    await writeFile(helper, syntheticHistoryHelper());
    await copyFiles([new FileMatcher(helper, path.join(root, "resources", entry.to), value => value, entry.filter)], undefined, false);
    assert.deepEqual(await readFile(path.join(root, "resources", entry.to)), syntheticHistoryHelper());
  }
});

test("the workspace helper resource is copied outside ASAR and remains a valid PE", async context => {
  const entry = YAML.parse(source).extraResources.find(entry => entry.from === "native/target/release/firefly-workspace.exe");
  assert.deepEqual(entry, { from: "native/target/release/firefly-workspace.exe", to: "bin/firefly-workspace.exe" });
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-resource-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, entry.from); await mkdir(path.dirname(helper), { recursive: true }); await writeFile(helper, syntheticHistoryHelper());
  await copyFiles([new FileMatcher(helper, path.join(root, "resources", entry.to), value => value)], undefined, false);
  const { verifyWorkspaceHelper } = await import("../verify/workspace-helper.mjs");
  assert.equal((await verifyWorkspaceHelper(path.join(root, "resources", "bin"))).size, syntheticHistoryHelper().length);
});

test("both Windows package entrypoints build and verify both helpers before packaging", () => {
  assert.equal(packageJson.scripts["build:history-helpers"], "node scripts/build/history-helpers.mjs");
  assert.equal(packageJson.scripts["verify:history-helpers"], "node scripts/verify/history-helpers.mjs");
  for (const key of ["package:win:dir", "package:win"]) {
    const steps = packageJson.scripts[key]?.split(" && ");
    assert.ok(steps, `${key} is a supported Windows package entrypoint`);
    for (const step of ["npm run build", "npm run build:screenshot-helper", "npm run build:history-helpers", "npm run verify:history-helpers", "npm run build:workspace-helper", "npm run verify:workspace-helper", "npm run prepare:mingit"])
      assert.ok(steps.includes(step), `${key} must include ${step}`);
    const build = steps.indexOf("npm run build:history-helpers");
    const verify = steps.indexOf("npm run verify:history-helpers");
    const pack = steps.findIndex(step => step.startsWith("electron-builder --win"));
    assert.ok(build < verify && verify < pack, `${key} must verify built helpers before electron-builder`);
    assert.ok(steps.indexOf("npm run build:workspace-helper") < steps.indexOf("npm run verify:workspace-helper") && steps.indexOf("npm run verify:workspace-helper") < pack);
  }
  assert.match(packageJson.scripts["package:win:dir"], /electron-builder --win --dir && npm run verify:workspace-helper -- release\/win-unpacked\/resources\/bin && npm run verify:history-helpers -- release\/win-unpacked\/resources\/bin$/);
  assert.match(packageJson.scripts["package:win"], /electron-builder --win nsis --publish never && npm run verify:installer$/);
});

test("installer verification rejects missing packaged helpers before checking legacy artifacts", () => {
  assert.equal(packageJson.scripts["verify:installer"], "node scripts/verify/history-helpers.mjs release/win-unpacked/resources/bin && node scripts/verify/workspace-helper.mjs release/win-unpacked/resources/bin && node scripts/verify/installer-artifacts.mjs");
});

test("the real Windows NSIS workflow uses the same verified package entrypoint", () => {
  const steps = packageWorkflow.jobs.package.steps;
  assert.ok(steps.some(step => step.run === "npm run package:win"));
  assert.ok(!steps.some(step => /npx electron-builder/.test(step.run ?? "")));
  assert.ok(steps.some(step => step.run === "npm run verify:installer"));
  assert.deepEqual(packageWorkflow.permissions, { contents: "read" });
});

test("pinned retrieval models and provenance ship externally without unrelated models", async context => {
  const entry = YAML.parse(source).extraResources.find(entry => entry.from === "models");
  assert.ok(entry, "package must include the pinned local retrieval models");
  const root = await mkdtemp(path.join(os.tmpdir(), "firefly-model-package-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const required = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "sentencepiece.bpe.model", "onnx/model_quantized.onnx", "README.md"];
  const shipped = [...required.map(name => "Xenova/bge-m3/" + name), ...required.map(name => "bge-reranker-base/" + name), "provenance/FlagEmbedding-LICENSE", "provenance/smh-pinned-assets.json"];
  for (const name of [...shipped, "unrelated-model/onnx/model.onnx", "cache/untrusted.bin"]) {
    const location = path.join(root, "models", name);
    await mkdir(path.dirname(location), { recursive: true });
    await writeFile(location, name);
  }
  await copyFiles([new FileMatcher(path.join(root, entry.from), path.join(root, "resources", entry.to), value => value, entry.filter)], undefined, false);
  for (const name of shipped) assert.equal(await readFile(path.join(root, "resources/models", name), "utf8"), name);
  await assert.rejects(access(path.join(root, "resources/models/unrelated-model/onnx/model.onnx")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "resources/models/cache/untrusted.bin")), { code: "ENOENT" });
});

test("Main compilation omits simulator sources while the independent simulator entry set retains them", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const compileSet = config => {
    const loaded = ts.readConfigFile(path.join(root, config), ts.sys.readFile);
    assert.equal(loaded.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
    assert.deepEqual(parsed.errors, []);
    return ts.createProgram(parsed.fileNames, parsed.options).getSourceFiles()
      .map(file => path.relative(root, file.fileName).split(path.sep).join("/"));
  };
  const main = compileSet("tsconfig.main.json");
  assert.ok(main.includes("src/main/index.ts"));
  assert.deepEqual(main.filter(file => file.startsWith("src/main/sim/")), [],
    "production Main must not compile simulator roots or import them transitively");
  const sim = compileSet("tsconfig.sim.json");
  assert.ok(sim.includes("src/main/sim/dmae-sim.ts"));
  assert.ok(sim.includes("src/main/sim/run-l2-sim.ts"));
  assert.ok(sim.includes("src/main/rag/worldbook.ts"));
});

test("installer file selection excludes both simulator outputs while retaining production entries", async context => {
  const config = YAML.parse(source);
  const root = await mkdtemp(path.join(os.tmpdir(), "firefly-simulator-package-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input"), destination = path.join(root, "selected");
  const retained = [
    "dist/main/main/index.js", "dist/preload/preload/index.js",
    "dist/renderer/react/index.html", "dist/cli/index.js", "package.json",
  ];
  const omitted = [
    "dist/main/main/sim/dmae-sim.js", "dist/main/main/sim/render/stats.js",
    "dist/sim/main/sim/run-l2-sim.js",
  ];
  for (const file of [...retained, ...omitted]) {
    const location = path.join(input, file);
    await mkdir(path.dirname(location), { recursive: true });
    await writeFile(location, file);
  }
  await copyFiles([new FileMatcher(input, destination, value => value, config.files)], undefined, false);
  for (const file of retained) assert.equal(await readFile(path.join(destination, file), "utf8"), file);
  for (const file of omitted) await assert.rejects(access(path.join(destination, file)), { code: "ENOENT" });
});
