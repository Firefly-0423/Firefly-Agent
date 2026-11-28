import { afterEach, expect, it, vi } from "vitest";

// Packaged worker threads cannot resolve the Electron module. A throwing factory
// reproduces that: any static `electron` import reachable from the worker entry fails to load.
vi.mock("electron", () => { throw new Error("Cannot find module 'electron'"); });
afterEach(() => { vi.resetModules(); });

it("loads the document index worker entry when Electron cannot be resolved, as in a packaged worker thread", async () => {
  const worker = await import("./document-index-worker");
  expect(typeof worker.runDocumentIndexJob).toBe("function");
});

it("lists model directories without the Electron app path when Electron cannot be resolved", async () => {
  const { getProjectModelsDirCandidates } = await import("./model-status");
  const candidates = getProjectModelsDirCandidates();
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.every(dir => dir.endsWith("models"))).toBe(true);
});
