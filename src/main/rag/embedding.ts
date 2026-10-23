import { checkEmbeddingModelInstalled, getProjectModelBaseDir } from "./model-status";
import * as path from "path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export class EmbeddingDimensionMismatchError extends Error {
  constructor(public readonly declared: number, public readonly actual: number, public readonly context: string) {
    super(`Embedding dimension mismatch: ${context} — declared ${declared}, got ${actual}`); this.name = "EmbeddingDimensionMismatchError";
  }
}
export class EmbeddingBatchDimensionInconsistencyError extends Error {
  constructor(public readonly expected: number, public readonly actual: number, public readonly index: number) {
    super(`Embedding batch inconsistency at index ${index}: expected ${expected} dimensions, got ${actual}`); this.name = "EmbeddingBatchDimensionInconsistencyError";
  }
}
export type EmbeddingProviderIdentity = { provider: string; model: string; dimensions: number; endpoint?: string };
export interface EmbeddingIndexMetadata { provider: string; model: string; dimensions: number; cacheIdentity: string }
export type EmbeddingWorkerConfig = { provider: "local"; modelKey: string }
  | { provider: "openai-compat"; baseUrl: string; apiKey: string; model: string };
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>; embedBatch(texts: string[]): Promise<number[][]>;
  readonly dims: number; readonly name: string;
  readonly cacheIdentity?: EmbeddingProviderIdentity; readonly workerConfig?: EmbeddingWorkerConfig;
  readonly declaredDimensions?: number; readonly resolvedDimensions?: number;
}

const models: Record<string, { key: string; hfName: string; dims: number }> = {
  bgem3: { key: "bgem3", hfName: "Xenova/bge-m3", dims: 1024 },
};
const revision = "4de13258303883538bd53b696b452bf8099f0858";
const pinnedFiles: Array<[string, string]> = [
  ["config.json", "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95"],
  ["special_tokens_map.json", "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835"],
  ["tokenizer_config.json", "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4"],
  ["sentencepiece.bpe.model", "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865"],
  ["tokenizer.json", "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790"],
  ["onnx/model_quantized.onnx", "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d"],
];
let loadingTail: Promise<unknown> = Promise.resolve();
const localInstances = new WeakSet<object>();
export function withLocalModelLoad<T>(load: () => Promise<T>): Promise<T> {
  const queued = loadingTail.then(load);
  loadingTail = queued.catch(() => {});
  return queued;
}
export function isLocalEmbeddingProvider(value: object): boolean { return localInstances.has(value); }
async function checkModelFiles(directory: string): Promise<void> {
  for (const [relative, expected] of pinnedFiles) {
    const digest = createHash("sha256");
    const stream = createReadStream(path.join(directory, "Xenova/bge-m3", relative));
    for await (const bytes of stream) digest.update(bytes);
    if (digest.digest("hex") !== expected) throw Error("LOCAL_MODEL_PIN_MISMATCH");
  }
}

const pipelines = new Map<string, any>();
const pendingPipelines = new Map<string, Promise<any>>();
let selectedKey = "bgem3";
let initializationCount = 0;
let selectedProvider: EmbeddingProvider | null = null;
// Function keeps TypeScript's CommonJS transform from rewriting the ESM import.
const loadEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;
async function pipelineFor(requested?: string): Promise<any> {
  const key = requested || selectedKey;
  const model = models[key];
  if (!model) throw new Error("Unknown embedding model: " + key);
  const ready = pipelines.get(key);
  if (ready) return ready;
  const pending = pendingPipelines.get(key);
  if (pending) return pending;
  const start = withLocalModelLoad(async () => {
    initializationCount += 1;
    const { pipeline, env } = await loadEsm("@xenova/transformers");
    env.allowLocalModels = true; env.allowRemoteModels = false;
    env.useBrowserCache = false; env.useFSCache = false; env.useCustomCache = false;
    const directory = getProjectModelBaseDir("embedding", key);
    if (!directory) throw new Error(`Local embedding model "${key}" is not installed`);
    await checkModelFiles(directory);
    env.localModelPath = directory;
    const instance = await pipeline("feature-extraction", model.hfName, { quantized: true, local_files_only: true, revision });
    pipelines.set(key, instance);
    return instance;
  });
  pendingPipelines.set(key, start);
  try { return await start; } finally { pendingPipelines.delete(key); }
}

export function decodeLocalEmbeddingBatch(result: { dims: number[]; data: ArrayLike<number> }, count: number, dimensions: number): number[][] {
  if (!Array.isArray(result.dims) || result.dims.length !== 2 || result.dims[0] !== count
    || result.dims[1] !== dimensions || result.data?.length !== count * dimensions) throw Error("LOCAL_EMBEDDING_OUTPUT_INVALID");
  const scalars = Array.from(result.data);
  const vectors: number[][] = [];
  for (let offset = 0; offset < count; offset++) {
    const vector = scalars.slice(offset * dimensions, (offset + 1) * dimensions);
    const length = Math.sqrt(vector.reduce((sum, scalar) => sum + scalar * scalar, 0));
    if (vector.some((scalar) => !Number.isFinite(scalar)) || Math.abs(length - 1) > 0.001) throw Error("LOCAL_EMBEDDING_OUTPUT_INVALID");
    vectors.push(vector);
  }
  return vectors;
}
export function createLocalEmbeddingProvider(modelKey?: string): EmbeddingProvider | null {
  const key = modelKey || "bgem3";
  const model = models[key];
  if (!model) throw new Error("Unknown embedding model: " + key);
  if (!getProjectModelBaseDir("embedding", key)) return null;
  const instance: EmbeddingProvider = {
    name: "local-" + model.hfName.split("/").pop(), dims: model.dims,
    declaredDimensions: model.dims, resolvedDimensions: model.dims,
    cacheIdentity: { provider: "local", model: model.hfName + "@" + revision + ":cls-normalized-q8-v1", dimensions: model.dims },
    workerConfig: { provider: "local", modelKey: key },
    async embed(text: string): Promise<number[]> {
      const run = await pipelineFor(key);
      const tensor: any = await run(text, { pooling: "cls", normalize: true });
      return decodeLocalEmbeddingBatch(tensor, 1, model.dims)[0];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const run = await pipelineFor(key);
      const tensor: any = await run(texts, { pooling: "cls", normalize: true });
      return decodeLocalEmbeddingBatch(tensor, texts.length, model.dims);
    },
  };
  localInstances.add(instance);
  return Object.freeze(instance);
}

// The declaration and first response are independent checks: a later response must
// agree with both. A mixed batch is rejected before either check mutates state.
function dimensionTracker(declared: number | undefined) {
  let dimensions = declared;
  let observed = false;
  return {
    value: () => dimensions,
    validate(vector: number[], context: string): void {
      const actual = vector.length;
      if (declared !== undefined && declared !== actual) throw new EmbeddingDimensionMismatchError(declared, actual, context);
      if (!observed) { dimensions = actual; observed = true; }
      else if (dimensions !== actual) throw new EmbeddingDimensionMismatchError(dimensions!, actual, context);
    },
  };
}
function validateBatch(vectors: number[][]): void {
  if (vectors.length === 0) return;
  const expected = vectors[0].length;
  for (let offset = 1; offset < vectors.length; offset++) {
    const actual = vectors[offset].length;
    if (actual !== expected) throw new EmbeddingBatchDimensionInconsistencyError(expected, actual, offset);
  }
}
export function createOpenAIEmbeddingProvider(baseUrl: string, apiKey: string, model = "text-embedding-ada-002", declaredDimensions?: number): EmbeddingProvider {
  const base = baseUrl.replace(/\/+$/, "");
  const endpoint = base + "/embeddings";
  const tracker = dimensionTracker(declaredDimensions);
  const request = (input: string | string[]): RequestInit => ({ method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body: JSON.stringify({ model, input }) });
  return {
    name: "openai-compat-" + model,
    get dims() {
      const dimensions = tracker.value();
      if (dimensions !== undefined) return dimensions;
      throw new Error("Embedding dimensions not yet resolved — call embed() first");
    },
    get declaredDimensions() { return declaredDimensions; },
    get resolvedDimensions() { return tracker.value(); },
    get cacheIdentity(): EmbeddingProviderIdentity | undefined {
      const dimensions = tracker.value();
      if (dimensions === undefined) return undefined;
      return { provider: "openai-compat", model, dimensions, endpoint: base };
    },
    get workerConfig(): EmbeddingWorkerConfig { return { provider: "openai-compat", baseUrl: base, apiKey, model }; },
    async embed(text: string): Promise<number[]> {
      const response = await fetch(endpoint, request(text));
      if (!response.ok) throw new Error("Embedding API error: " + response.status + " " + await response.text());
      const payload = await response.json() as { data: Array<{ embedding: number[] }> };
      const vector = payload.data[0].embedding;
      tracker.validate(vector, `embed() for model "${model}"`);
      return vector;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      const response = await fetch(endpoint, request(texts));
      if (!response.ok) throw new Error("Embedding API error: " + response.status + " " + await response.text());
      const payload = await response.json() as { data: Array<{ embedding: number[] }> };
      const vectors = payload.data.map((item) => item.embedding);
      validateBatch(vectors);
      for (const vector of vectors) tracker.validate(vector, `embedBatch() for model "${model}"`);
      return vectors;
    },
  };
}
export function getEmbeddingProvider(mode: "auto" | "local" | "cloud" = "auto", cloudBaseUrl?: string, cloudApiKey?: string, modelKey?: string, cloudDimensions?: number): EmbeddingProvider | null {
  if (selectedProvider) return selectedProvider;
  const cloud = () => createOpenAIEmbeddingProvider(cloudBaseUrl!, cloudApiKey!, modelKey, cloudDimensions);
  if (mode === "local") selectedProvider = createLocalEmbeddingProvider(modelKey);
  else if (mode === "cloud" && cloudBaseUrl && cloudApiKey) selectedProvider = cloud();
  else {
    const local = createLocalEmbeddingProvider(modelKey);
    selectedProvider = local ? local : cloudBaseUrl && cloudApiKey ? cloud() : null;
  }
  return selectedProvider;
}
export async function getEmbeddingProviderIdentity(): Promise<EmbeddingProviderIdentity> {
  const instance = getEmbeddingProvider();
  if (!instance) throw new Error("Embedding provider is not available");
  if (instance.cacheIdentity) return instance.cacheIdentity;
  const local = Object.values(models).find((model) => instance.name === "local-" + model.hfName.split("/").pop());
  if (local) return { provider: "local", model: local.hfName, dimensions: instance.dims };
  const prefix = "openai-compat-";
  if (instance.name.startsWith(prefix)) {
    const dimensions = instance.resolvedDimensions ?? instance.declaredDimensions;
    if (dimensions === undefined) throw new Error("Embedding dimensions not yet resolved for cloud provider. " + "Call embed() first, or declare dimensions in settings.");
    return { provider: "openai-compat", model: instance.name.slice(prefix.length), dimensions };
  }
  const dimensions = instance.resolvedDimensions ?? instance.declaredDimensions;
  if (dimensions === undefined) throw new Error("Embedding dimensions not yet resolved for provider: " + instance.name);
  return { provider: instance.name, model: instance.name, dimensions };
}
export function getEmbeddingWorkerConfig(): EmbeddingWorkerConfig {
  const instance = getEmbeddingProvider();
  if (!instance) throw new Error("Embedding provider is not available");
  if (instance.workerConfig) return instance.workerConfig;
  return { provider: "local", modelKey: selectedKey };
}
export function getCurrentModelKey(): string { return selectedKey; }
export function getCurrentModelDims(): number { const model = models[selectedKey]; return model ? model.dims : 1024; }
export function switchEmbeddingModel(modelKey: string): void {
  if (modelKey !== "bgem3") {
    console.warn(`[Embedding] ignoring model switch to "${modelKey}" — bge-m3 is the only supported model`);
    return;
  }
  selectedProvider = null;
  pipelines.delete(selectedKey); pendingPipelines.delete(selectedKey); selectedKey = modelKey;
}
export function resetEmbeddingProvider(): void {
  selectedProvider = null;
  pipelines.clear(); pendingPipelines.clear(); selectedKey = "bgem3"; initializationCount = 0;
}
export function getEmbeddingDiagnostics(): { currentModelKey: string; cachedPipelineKeys: string[]; loadingPipelineKeys: string[]; localPipelineInitCount: number } {
  return { currentModelKey: selectedKey, cachedPipelineKeys: Array.from(pipelines.keys()),
    loadingPipelineKeys: Array.from(pendingPipelines.keys()), localPipelineInitCount: initializationCount };
}
export { checkEmbeddingModelInstalled };
