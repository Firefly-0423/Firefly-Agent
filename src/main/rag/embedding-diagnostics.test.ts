import { expect, it } from "vitest";
import { resetEmbeddingProvider, getEmbeddingDiagnostics } from "./embedding";

it("can inspect an unused embedding provider without initializing pipelines", () => {
  resetEmbeddingProvider();
  const { localPipelineInitCount, currentModelKey, loadingPipelineKeys, cachedPipelineKeys } = getEmbeddingDiagnostics();
  expect([currentModelKey, localPipelineInitCount]).toEqual(["bgem3", 0]);
  expect([cachedPipelineKeys, loadingPipelineKeys]).toEqual([[], []]);
});
