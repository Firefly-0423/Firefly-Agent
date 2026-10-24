import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const locations = vi.hoisted(() => ({ root: "", home: "" }));
vi.mock("os", async () => ({ ...await vi.importActual<typeof import("os")>("os"), homedir: () => locations.home }));
vi.mock("electron", () => ({ app: { getAppPath: () => locations.root } }));
const originalCwd = process.cwd();
const required = ["tokenizer.json", "config.json", "onnx/model_quantized.onnx"];
beforeEach(() => {
  locations.root = mkdtempSync(join(tmpdir(), "ff-model-locations-"));
  locations.home = join(locations.root, "home");
  mkdirSync(locations.home);
  process.chdir(locations.root);
  vi.stubEnv("FIREFLY_MODELS_DIR", undefined);
  vi.resetModules();
});
afterEach(() => { process.chdir(originalCwd); vi.unstubAllEnvs(); rmSync(locations.root, { force: true, recursive: true }); });
function install(folder: string, files = required) {
  for (const filename of files) { const target = join(folder, filename); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "{}"); }
  return folder;
}
const project = () => join(locations.root, "models", "Xenova", "bge-m3");
const cached = () => join(locations.home, ".cache", "huggingface", "Xenova", "bge-m3");
const api = () => import("./model-status");
it("prioritizes explicit, working-directory and executable locations and deduplicates equal candidates", async () => {
  const model = await api(), expected = join(locations.root, "models");
  expect(model.getProjectModelsDirCandidates()[0]).toBe(expected);
  expect(model.getProjectModelsDirCandidates()).toContain(expected);
  expect(model.getProjectModelsDir()).toBe(join(process.cwd(), "models"));
  expect(model.getProjectModelsDirCandidates()).toContain(join(dirname(process.execPath), "models"));
  const override = join(locations.root, "preferred-models");
  vi.stubEnv("FIREFLY_MODELS_DIR", override);
  expect(model.getProjectModelsDirCandidates()[0]).toBe(override);
  vi.stubEnv("FIREFLY_MODELS_DIR", expected);
  const candidates = model.getProjectModelsDirCandidates();
  expect(new Set(candidates).size).toBe(candidates.length);
});
it("finds a complete later model instead of stopping at an empty override", async () => {
  vi.stubEnv("FIREFLY_MODELS_DIR", join(locations.root, "empty-models"));
  install(project());
  expect((await api()).getProjectModelBaseDir("embedding", "bgem3")).toBe(join(locations.root, "models"));
});
it("detects the canonical project model and the standalone reranker layout", async () => {
  install(project());
  install(join(locations.root, "models", "bge-reranker-base"));
  const model = await api(), detail = model.getModelInstallStatusDetail("embedding", "bgem3");
  expect(detail).toMatchObject({ installed: true, source: "project", matchedAt: project(), existingProjectDir: project(), missingFiles: [] });
  expect(model.checkRerankerModelInstalled()).toBe(true);
  expect(model.getModelInstallStatus()).toEqual({ embedding: { bgem3: true }, reranker: { standard: true } });
});
it("does not accept the bare project embedding layout", async () => {
  install(join(locations.root, "models", "bge-m3"));
  const detail = (await api()).getModelInstallStatusDetail("embedding", "bgem3");
  expect(detail.installed).toBe(false);
  expect(detail.existingProjectDir).toBeNull();
});
it.each([false, true])("uses the HF cache when project model is absent, including wrong-layout=%s", async wrongLayout => {
  mkdirSync(join(locations.root, "models"), { recursive: true });
  if (wrongLayout) install(join(locations.root, "models", "bge-m3"), ["tokenizer.json"]);
  install(cached());
  const model = await api(), detail = model.getModelInstallStatusDetail("embedding", "bgem3");
  expect(detail).toMatchObject({ installed: true, source: "hf-cache", matchedAt: cached(), existingProjectDir: null });
  expect(model.getModelInstallStatus().embedding.bgem3).toBe(true);
});
it("reports incomplete canonical installs without masking them with a complete cache", async () => {
  install(project(), ["tokenizer.json"]);
  install(cached());
  const model = await api(), detail = model.getModelInstallStatusDetail("embedding", "bgem3");
  expect(detail).toMatchObject({ installed: false, source: null, matchedAt: null, existingProjectDir: project() });
  expect(detail.requiredFiles).toEqual(required);
  expect(detail.missingFiles).toEqual(["config.json", "onnx/model_quantized.onnx"]);
  expect(detail.missingFiles).not.toContain("tokenizer.json");
  expect(model.getModelInstallStatus().embedding.bgem3).toBe(false);
});
it("returns empty diagnostics when neither project nor cache contains a model", async () => {
  mkdirSync(join(locations.root, "models"));
  const detail = (await api()).getModelInstallStatusDetail("embedding", "bgem3");
  expect(detail).toMatchObject({ installed: false, source: null, existingProjectDir: null, missingFiles: [] });
});
it("chooses project data ahead of an equally complete HF cache", async () => {
  install(cached());
  install(project());
  expect((await api()).getModelInstallStatusDetail("embedding", "bgem3")).toMatchObject({ source: "project", matchedAt: project() });
});
