import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./model-status", () => ({
  getProjectModelBaseDir: vi.fn(), checkEmbeddingModelInstalled: vi.fn(() => false),
}));
import { getProjectModelBaseDir } from "./model-status";
import {
  checkEmbeddingModelInstalled, createLocalEmbeddingProvider, createOpenAIEmbeddingProvider,
  decodeLocalEmbeddingBatch, EmbeddingBatchDimensionInconsistencyError, EmbeddingDimensionMismatchError,
  getCurrentModelDims, getCurrentModelKey, getEmbeddingDiagnostics, getEmbeddingProvider,
  getEmbeddingProviderIdentity, getEmbeddingWorkerConfig, isLocalEmbeddingProvider,
  resetEmbeddingProvider, switchEmbeddingModel, withLocalModelLoad,
} from "./embedding";

beforeEach(() => { resetEmbeddingProvider(); vi.mocked(getProjectModelBaseDir).mockReturnValue(null); });
afterEach(() => { resetEmbeddingProvider(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function response(rows: number[][]) {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rows.map(embedding => ({ embedding })) }) });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("embedding providers", () => {
  it("posts normalized URLs, default model and text, then exposes the resolved identity", async () => {
    const fetch = response([[1, 0]]);
    const provider = createOpenAIEmbeddingProvider("https://fixture.invalid/v1///", "fixture-key");
    expect(() => provider.dims).toThrow(new Error("Embedding dimensions not yet resolved — call embed() first"));
    expect(provider.cacheIdentity).toBeUndefined();
    expect(provider.declaredDimensions).toBeUndefined();
    expect(provider.resolvedDimensions).toBeUndefined();
    expect(await provider.embed("hello")).toEqual([1, 0]);
    expect(fetch).toHaveBeenCalledWith("https://fixture.invalid/v1/embeddings", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-key" },
      body: JSON.stringify({ model: "text-embedding-ada-002", input: "hello" }),
    });
    expect(provider.dims).toBe(2);
    expect(provider.cacheIdentity).toEqual({ provider: "openai-compat", model: "text-embedding-ada-002", dimensions: 2, endpoint: "https://fixture.invalid/v1" });
    expect(provider.workerConfig).toEqual({ provider: "openai-compat", model: "text-embedding-ada-002", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" });
  });

  it("returns batches in response order and sends empty batches without resolving dimensions", async () => {
    const fetch = response([]);
    const provider = createOpenAIEmbeddingProvider("https://fixture.invalid", "key", "custom");
    expect(await provider.embedBatch([])).toEqual([]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ model: "custom", input: [] });
    expect(provider.resolvedDimensions).toBeUndefined();
    response([[0, 1], [1, 0]]);
    expect(await provider.embedBatch(["a", "b"])).toEqual([[0, 1], [1, 0]]);
    expect(provider.dims).toBe(2);
  });

  it.each(["embed", "embedBatch"] as const)("propagates exact HTTP errors from %s", async method => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" }));
    const provider = createOpenAIEmbeddingProvider("https://fixture.invalid", "key");
    await expect(method === "embed" ? provider.embed("a") : provider.embedBatch(["a"]))
      .rejects.toThrow(new Error("Embedding API error: 429 slow down"));
  });

  it("preserves declared dimensions after mismatch and rejects later dimension drift", async () => {
    response([[1, 0]]);
    const declared = createOpenAIEmbeddingProvider("https://fixture.invalid", "key", "custom", 3);
    expect(declared.dims).toBe(3);
    await expect(declared.embed("x")).rejects.toMatchObject({ name: "EmbeddingDimensionMismatchError", declared: 3, actual: 2, context: 'embed() for model "custom"', message: 'Embedding dimension mismatch: embed() for model "custom" — declared 3, got 2' });
    expect(declared.resolvedDimensions).toBe(3);
    const detected = createOpenAIEmbeddingProvider("https://fixture.invalid", "key", "custom");
    await detected.embed("x");
    response([[1, 0, 0]]);
    await expect(detected.embedBatch(["x"])).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(detected.dims).toBe(2);
  });

  it("rejects inconsistent batches before resolving a dimension", async () => {
    response([[1], [1, 0]]);
    const provider = createOpenAIEmbeddingProvider("https://fixture.invalid", "key");
    await expect(provider.embedBatch(["a", "b"])).rejects.toMatchObject({
      name: "EmbeddingBatchDimensionInconsistencyError", expected: 1, actual: 2, index: 1,
      message: "Embedding batch inconsistency at index 1: expected 1 dimensions, got 2",
    });
    expect(provider.resolvedDimensions).toBeUndefined();
    expect(new EmbeddingBatchDimensionInconsistencyError(1, 2, 1)).toBeInstanceOf(Error);
  });

  it("uses local metadata without loading a model and identifies only factory instances", async () => {
    expect(createLocalEmbeddingProvider()).toBeNull();
    expect(() => createLocalEmbeddingProvider("missing")).toThrow(new Error("Unknown embedding model: missing"));
    vi.mocked(getProjectModelBaseDir).mockReturnValue("fixture-models");
    const provider = createLocalEmbeddingProvider()!;
    expect(provider).toMatchObject({ name: "local-bge-m3", dims: 1024, declaredDimensions: 1024, resolvedDimensions: 1024, workerConfig: { provider: "local", modelKey: "bgem3" } });
    expect(isLocalEmbeddingProvider(provider)).toBe(true);
    expect(isLocalEmbeddingProvider({ ...provider })).toBe(false);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(await provider.embedBatch([])).toEqual([]);
    expect(getEmbeddingDiagnostics().localPipelineInitCount).toBe(0);
    expect(checkEmbeddingModelInstalled("bgem3")).toBe(false);
  });

  it("selects local first, caches providers, and resets model and diagnostics", async () => {
    vi.mocked(getProjectModelBaseDir).mockReturnValue("fixture-models");
    const local = getEmbeddingProvider("auto", "https://fixture.invalid", "key");
    expect(isLocalEmbeddingProvider(local!)).toBe(true);
    expect(getEmbeddingProvider("cloud", "https://other.invalid", "key")).toBe(local);
    expect(await getEmbeddingProviderIdentity()).toEqual(local!.cacheIdentity);
    expect(getEmbeddingWorkerConfig()).toEqual({ provider: "local", modelKey: "bgem3" });
    switchEmbeddingModel("unsupported");
    expect(getEmbeddingProvider()).toBe(local);
    switchEmbeddingModel("bgem3");
    expect(getEmbeddingProvider()).not.toBe(local);
    resetEmbeddingProvider();
    expect(getCurrentModelKey()).toBe("bgem3");
    expect(getCurrentModelDims()).toBe(1024);
    expect(getEmbeddingDiagnostics()).toEqual({ currentModelKey: "bgem3", cachedPipelineKeys: [], loadingPipelineKeys: [], localPipelineInitCount: 0 });
  });

  it("falls back to cloud only with complete credentials and resolves its identity", async () => {
    expect(getEmbeddingProvider()).toBeNull();
    expect(getEmbeddingProvider("local", "https://fixture.invalid", "key")).toBeNull();
    expect(getEmbeddingProvider("cloud", "https://fixture.invalid")).toBeNull();
    const provider = getEmbeddingProvider("auto", "https://fixture.invalid", "key")!;
    await expect(getEmbeddingProviderIdentity()).rejects.toThrow(new Error("Embedding dimensions not yet resolved for cloud provider. Call embed() first, or declare dimensions in settings."));
    response([[1]]);
    await provider.embed("a");
    expect(await getEmbeddingProviderIdentity()).toEqual(provider.cacheIdentity);
    expect(getEmbeddingWorkerConfig()).toEqual(provider.workerConfig);
  });

  it("reports unavailable providers and supports explicitly declared cloud identity", async () => {
    await expect(getEmbeddingProviderIdentity()).rejects.toThrow(new Error("Embedding provider is not available"));
    expect(() => getEmbeddingWorkerConfig()).toThrow(new Error("Embedding provider is not available"));
    const provider = getEmbeddingProvider("cloud", "https://fixture.invalid", "key", "custom", 2)!;
    expect(await getEmbeddingProviderIdentity()).toEqual(provider.cacheIdentity);
  });

  it("serializes local loads and allows the next load after rejection", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withLocalModelLoad(async () => { order.push("start"); await gate; order.push("end"); throw new Error("failed"); });
    const rejection = expect(first).rejects.toThrow(new Error("failed"));
    const second = withLocalModelLoad(async () => { order.push("next"); return 42; });
    await Promise.resolve();
    expect(order).toEqual(["start"]);
    release();
    await rejection;
    expect(await second).toBe(42);
    expect(order).toEqual(["start", "end", "next"]);
  });
});

describe("local tensor decoding", () => {
  it("splits finite normalized rows and accepts an empty batch", () => {
    expect(decodeLocalEmbeddingBatch({ dims: [2, 2], data: new Float32Array([1, 0, 0, -1]) }, 2, 2)).toEqual([[1, 0], [0, -1]]);
    expect(decodeLocalEmbeddingBatch({ dims: [0, 2], data: [] }, 0, 2)).toEqual([]);
  });
  it.each([
    { dims: [2], data: [1, 0] }, { dims: [2, 2], data: [1, 0] },
    { dims: [1, 3], data: [1, 0] }, { dims: [1, 2], data: [1] },
    { dims: [1, 2], data: [0, 0] }, { dims: [1, 2], data: [NaN, 1] },
    { dims: [1, 2], data: [Infinity, 0] }, { dims: [1, 2], data: [1.01, 0] },
  ])("rejects invalid tensor %#", tensor => {
    expect(() => decodeLocalEmbeddingBatch(tensor, 1, 2)).toThrow(new Error("LOCAL_EMBEDDING_OUTPUT_INVALID"));
  });
});
