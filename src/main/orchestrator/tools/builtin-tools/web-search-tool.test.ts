import { beforeEach, afterEach, it, expect, describe, vi } from "vitest";
import { webSearchTool, setSearchConfig, clearWebSearchCache } from "./web-search-tool";

const response = (rows: unknown[] = []) => new Response(JSON.stringify({ webPages: { value: rows } }));
const row = { name: "Observatory schedule", url: "https://sky.example/schedule", snippet: "Night observations" };
const search = async (query: string) => JSON.parse(await webSearchTool.execute({ query }));
beforeEach(() => { clearWebSearchCache(); setSearchConfig(() => "bocha", () => "fixture-bocha-73", () => "fixture-tavily-73", () => ""); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("search freshness and cache identity", () => {
  it("reuses results with a timestamp and leaves the first response unmarked", async () => {
    const network = vi.fn(async () => response([row]));
    vi.stubGlobal("fetch", network);
    const first = await search("observatory hours");
    expect(first.cached).toBeUndefined();
    expect(first.resultCount).toEqual(1);
    const next = await search("observatory hours");
    expect(network).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ cached: true, cachedAt: expect.any(String), resultCount: 1, results: first.results });
  });
  it("issues independent requests for different keywords", async () => {
    const network = vi.fn(async () => response());
    vi.stubGlobal("fetch", network);
    await search("lunar eclipse");
    await search("meteor shower");
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("collapses repeated whitespace for cache lookup", async () => {
    const network = vi.fn(async () => response());
    vi.stubGlobal("fetch", network);
    await search("meteor   shower");
    expect((await search("meteor shower")).cached).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("retries after a provider failure and returns an unmarked successful response", async () => {
    const network = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(response([row]));
    vi.stubGlobal("fetch", network);
    await expect(webSearchTool.execute({ query: "sky forecast" })).rejects.toThrow("搜索失败");
    const recovered = await search("sky forecast");
    expect(recovered.cached).toBeUndefined();
    expect(recovered.resultCount).toBe(1);
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("refreshes an entry after thirty-one minutes", async () => {
    vi.useFakeTimers();
    const network = vi.fn(async () => response());
    vi.stubGlobal("fetch", network);
    await search("tonight sky");
    expect(network).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31 * 60_000);
    expect((await search("tonight sky")).cached).toBeUndefined();
    expect(network).toHaveBeenCalledTimes(2);
  });
});
