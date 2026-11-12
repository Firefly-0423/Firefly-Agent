import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fetchUrlTool, clearFetchUrlCache } from "./fetch-url-tool";
import { gzipSync } from "node:zlib";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

const reply = (body: string, type = "text/plain", status = 200) => new Response(body, { status, headers: { "Content-Type": type } });
const articleText = "A detailed account of the observatory and its instruments. ".repeat(12);
const address = "https://github.com/observatory/field-guide";
const api = "https://api.github.com/repos/observatory/field-guide";
beforeEach(() => clearFetchUrlCache());
afterEach(() => vi.unstubAllGlobals());

describe("repository landing pages", () => {
  it("fetches metadata then README from the API and emits the complete summary", async () => {
    const network = vi.fn()
      .mockResolvedValueOnce(reply(JSON.stringify({ description: "Observatory handbook", stargazers_count: 872, forks_count: 19,
        language: "JavaScript", default_branch: "trunk", license: { spdx_id: "Apache-2.0" } })))
      .mockResolvedValueOnce(reply("# Field guide\n\nInstructions for observers."));
    vi.stubGlobal("fetch", network);
    const output = await fetchUrlTool.execute({ url: address });
    expect(network.mock.calls.map(([url]) => url)).toEqual([api, api + "/readme"]);
    expect(output).toEqual("URL: " + address + "\n来源: GitHub API（仓库元信息 + README 原文）\n\n# observatory/field-guide\n\n> Observatory handbook\n\nstars: 872 · forks: 19 · language: JavaScript · 默认分支: trunk · license: Apache-2.0\n\n---\n\n# Field guide\n\nInstructions for observers.");
    expect(output).not.toContain("<html>");
  });
  it("normalizes a git suffix followed by a trailing slash", async () => {
    const network = vi.fn().mockImplementation(async (url: string) => reply(url.endsWith("/readme") ? "Handbook" : "{}"));
    vi.stubGlobal("fetch", network);
    await fetchUrlTool.execute({ url: address + ".git/" });
    expect(network.mock.calls.map(([url]) => url)).toEqual([api, api + "/readme"]);
  });
  it("falls back to the original page when README retrieval fails", async () => {
    const network = vi.fn()
      .mockResolvedValueOnce(reply("", "text/plain", 404))
      .mockResolvedValueOnce(reply("", "text/plain", 404))
      .mockResolvedValueOnce(reply("<article><p>" + articleText + "</p></article>", "text/html"));
    vi.stubGlobal("fetch", network);
    const output = await fetchUrlTool.execute({ url: address });
    expect(network.mock.calls.map(([url]) => url)).toEqual([api, api + "/readme", address]);
    expect(output).not.toContain("来源: GitHub API");
    expect(output).toContain(articleText.trim());
  });
  it("keeps a successful README despite a metadata permission failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply("", "text/plain", 403)).mockResolvedValueOnce(reply("Standalone handbook")));
    expect(await fetchUrlTool.execute({ url: address })).toContain("Standalone handbook");
  });
  it.each(["https://github.com/topics/astronomy", address + "/tree/trunk/manual"])("treats %s as an ordinary page", async (url) => {
    const network = vi.fn(async (_url: unknown) => reply("<div>Directory content</div>", "text/html"));
    vi.stubGlobal("fetch", network);
    await fetchUrlTool.execute({ url });
    expect(network.mock.calls.map(([requested]) => requested)).toEqual([url]);
  });
  it("preserves original HTML and bypasses the API in raw mode", async () => {
    const html = "<html><body><main>Unprocessed handbook</main></body></html>";
    const network = vi.fn(async (_url: unknown) => reply(html, "text/html"));
    vi.stubGlobal("fetch", network);
    const result = await fetchUrlTool.execute({ url: address, format: "raw" });
    expect(network.mock.calls.map(([url]) => url)).toEqual([address]);
    expect(result).toContain(html);
  });
});

describe("page extraction", () => {
  it("retains article content while removing navigation and other page furniture", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(`<header>Brand controls</header><nav>Site links</nav><article><h1>Observatory record</h1><p>${articleText}</p></article><aside>Sponsored material</aside><footer>Legal notice</footer>`, "text/html")));
    const output = await fetchUrlTool.execute({ url: "https://handbook.example/article" });
    expect(output).toContain("# Observatory record");
    expect(output).toContain(articleText.trim());
    for (const excluded of ["Brand controls", "Site links", "Sponsored material", "Legal notice"]) expect(output).not.toContain(excluded);
  });
  it("selects main when an article is too short to be useful", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(`<article>Tiny widget</article><main><h1>Observation manual</h1><p>${articleText}</p></main>`, "text/html")));
    const output = await fetchUrlTool.execute({ url: "https://handbook.example/manual" });
    expect(output).toContain("# Observation manual");
    expect(output).toContain(articleText.trim());
    expect(output).not.toContain("Tiny widget");
  });
  it("uses the remaining page when no main or article exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(`<nav>Unused menu</nav><div><h1>Observation details</h1><p>${articleText}</p></div>`, "text/html")));
    const output = await fetchUrlTool.execute({ url: "https://handbook.example/details" });
    expect(output).toContain("# Observation details");
    expect(output).not.toContain("Unused menu");
  });
  it("preserves non-HTML text exactly after the response header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("angle brackets <remain> intact")));
    expect(await fetchUrlTool.execute({ url: "https://handbook.example/plain" }))
      .toEqual("URL: https://handbook.example/plain\nContent-Type: text/plain\n\nangle brackets <remain> intact");
  });
});

describe("fetch result reuse", () => {
  it("annotates only the second successful response and issues one request", async () => {
    const network = vi.fn(async () => reply("saved observation"));
    vi.stubGlobal("fetch", network);
    const first = await fetchUrlTool.execute({ url: "https://handbook.example/reuse" });
    const second = await fetchUrlTool.execute({ url: "https://handbook.example/reuse" });
    expect(first).toContain("saved observation");
    expect(first.startsWith("[缓存]")).toBe(false);
    expect(network).toHaveBeenCalledTimes(1);
    expect(second.startsWith("[缓存]")).toBe(true);
    expect(second).toContain("saved observation");
  });
  it("separates raw and markdown cache entries", async () => {
    const network = vi.fn(async () => reply("two formats"));
    vi.stubGlobal("fetch", network);
    for (const format of [undefined, "raw"]) await fetchUrlTool.execute({ url: "https://handbook.example/formats", format });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("retries failures instead of caching the diagnostic", async () => {
    const network = vi.fn().mockResolvedValueOnce(reply("", "text/plain", 500)).mockResolvedValueOnce(reply("restored observation"));
    vi.stubGlobal("fetch", network);
    expect((await fetchUrlTool.execute({ url: "https://handbook.example/retry" })).startsWith("[错误]")).toBe(true);
    const result = await fetchUrlTool.execute({ url: "https://handbook.example/retry" });
    expect(result).toContain("restored observation");
    expect(result.startsWith("[缓存]")).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
  });
});

describe("streaming response budget", () => {
  function oversizedResponse() {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(128 * 1024).fill(65));
      // Finite malicious fixture: the vulnerable implementation drains all 8 chunks.
      if (pull.mock.calls.length === 8) controller.close();
    });
    return { response: new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })), cancel, pull };
  }

  it("truncates ordinary pages at 512 KiB and cancels without draining the response", async () => {
    const { response, pull, cancel } = oversizedResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const result = await fetchUrlTool.execute({ url: "https://example.com/large", format: "raw" });
    expect(result).toContain("已截断到 524288 字节");
    expect(result.split("\n\n")[1]).toHaveLength(512 * 1024);
    expect(pull).toHaveBeenCalledTimes(5);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds both the GitHub README and metadata streams", async () => {
    const meta = oversizedResponse();
    const readme = oversizedResponse();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/readme") ? readme.response : meta.response));
    const result = await fetchUrlTool.execute({ url: "https://github.com/foo/bar" });
    expect(result).toContain("README 已截断到 524288 字节");
    expect(result).toContain("来源: GitHub API");
    expect(meta.pull).toHaveBeenCalledTimes(5);
    expect(meta.cancel).toHaveBeenCalledOnce();
    expect(readme.pull).toHaveBeenCalledTimes(5);
    expect(readme.cancel).toHaveBeenCalledOnce();
  });

  it("applies the budget to decompressed response bytes", async () => {
    const compressed = gzipSync(Buffer.alloc(1024 * 1024, 65));
    const decoded = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(decoded)));
    const result = await fetchUrlTool.execute({ url: "https://example.com/compressed", format: "raw" });
    expect(result).toContain("已截断到 524288 字节");
    expect(result.split("\n\n")[1]).toHaveLength(512 * 1024);
  });
});

