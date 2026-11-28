import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadFileTool } from "./download-file-tool";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
let root: string; const fetchMock = vi.fn();
const run = (args: Record<string, unknown>, signal?: AbortSignal) => downloadFileTool.execute(args, { resolvedWorkspaceRoot: root, signal } as never);
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-download-unit-")); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each([{}, { url: "file:///a" }, { url: "ftp://example.test/a" }])("rejects invalid URL %j before fetching", async args => { expect(await run(args)).toBe("[错误] url 必须以 http:// 或 https:// 开头"); expect(fetchMock).not.toHaveBeenCalled(); });
it.each(["bad?.png", "bad:name.png", "bad*.png"])("rejects filename characters %s", async filename => { expect(await run({ url: "https://example.test/a", filename })).toBe('[错误] filename 含非法字符（<>:"|?*）'); expect(fetchMock).not.toHaveBeenCalled(); });
it.each(["../outside.png", "sub/../../outside.png", "/outside.png"])("rejects paths %s before fetching", async filename => { expect(await run({ url: "https://example.test/a", filename })).toBe("[错误] 路径不合法（禁止目录穿越或绝对路径）: " + filename); expect(fetchMock).not.toHaveBeenCalled(); });
it.each(["exe", "bat", "cmd", "com", "scr", "msi", "ps1", "vbs", "lnk", "jar", "sh", "EXE"])("rejects executable .%s", async ext => { expect(await run({ url: `https://example.test/a.${ext}` })).toBe("[错误] 禁止下载可执行/脚本文件: ." + ext); expect(fetchMock).not.toHaveBeenCalled(); });
it("infers a decoded filename, drops queries and writes exact binary bytes", async () => {
  const bytes = Uint8Array.of(0, 255, 1); fetchMock.mockResolvedValue(new Response(bytes)); const expected = path.join(root, "a b.png");
  expect(await run({ url: "  https://example.test/a%20b.png?token=test  " })).toBe(`[download_file] 已保存：${expected}（0 KiB）`); expect(fs.readFileSync(expected)).toEqual(Buffer.from(bytes));
});
it("prefers an explicit subdirectory filename and preserves its extension", async () => {
  fetchMock.mockResolvedValue(new Response(new Uint8Array(1024))); const expected = path.join(root, "images", "a.bin"); expect(await run({ url: "https://example.test/image.png", filename: "images/a.bin" })).toBe(`[download_file] 已保存：${expected}（1 KiB）`); expect(fs.statSync(expected).size).toBe(1024);
});
it.each(["https://example.test/", "https://example.test/no-extension", "https://example.test/.png", "https://example.test/%zz"])("uses Content-Type and default basename for %s", async url => {
  fetchMock.mockResolvedValue(new Response("data", { headers: { "Content-Type": "IMAGE/PNG; charset=UTF-8" } })); expect(await run({ url })).toBe(`[download_file] 已保存：${path.join(root, "download.png")}（0 KiB）`);
});
it("formats MiB sizes", async () => { fetchMock.mockResolvedValue(new Response(new Uint8Array(1024 * 1024))); expect(await run({ url: "https://example.test/a.bin" })).toBe(`[download_file] 已保存：${path.join(root, "a.bin")}（1.0 MiB）`); });
it.each(["application/x-custom", ""])("rejects unknown content type %j without writing", async type => { fetchMock.mockResolvedValue(new Response(Uint8Array.of(1), { headers: type ? { "content-type": type } : {} })); expect(await run({ url: "https://example.test/" })).toBe(`[错误] 无法确定文件扩展名（Content-Type: ${type || "未知"}），请显式传入 filename 参数（如 cat.png）`); expect(fs.readdirSync(root)).toEqual([]); });
it("reports HTTP and absent-body errors", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" })); expect(await run({ url: "https://example.test/a.bin" })).toBe("[错误] HTTP 404 Not Found"); fetchMock.mockResolvedValue(new Response(null)); expect(await run({ url: "https://example.test/a.bin" })).toBe("[错误] 响应无内容（空 body）");
});
it("rejects oversized declared lengths before reading", async () => {
  fetchMock.mockResolvedValue(new Response("x", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } })); expect(await run({ url: "https://example.test/a.bin" })).toBe("[错误] 文件过大：67108865 字节超过上限 67108864 字节"); expect(fs.readdirSync(root)).toEqual([]);
});
it("contains network and stream failures without leaving partial files", async () => {
  fetchMock.mockRejectedValue(Error("offline")); expect(await run({ url: "https://example.test/a.bin" })).toBe("[错误] 下载失败: offline");
  fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(1)); c.error(Error("stream failed")); } }))); expect(await run({ url: "https://example.test/a.bin" })).toBe("[错误] 下载失败: stream failed"); expect(fs.readdirSync(root)).toEqual([]);
});
it("forwards caller cancellation", async () => {
  const ac = new AbortController(); ac.abort(Error("cancelled"));
  expect(await run({ url: "https://example.test/a.bin" }, ac.signal)).toBe("[错误] 下载失败: cancelled");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("aborts an idle request at 30 seconds and clears its timer", async () => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_yes, no) => signal.addEventListener("abort", () => no(Error("idle timeout")))));
    const pending = run({ url: "https://example.test/a.bin" });
    await vi.advanceTimersByTimeAsync(29999); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe("[错误] 下载失败: idle timeout"); expect(vi.getTimerCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  } finally { vi.useRealTimers(); }
});
it("rejects an oversized stream without leaving a partial file", async () => {
  let read = 0;
  fetchMock.mockResolvedValue(new Response(new ReadableStream({
    pull(controller) { controller.enqueue(++read === 1 ? new Uint8Array(64 * 1024 * 1024) : Uint8Array.of(1)); },
  }, { highWaterMark: 0 })));
  expect(await run({ url: "https://example.test/a.bin" })).toBe("[错误] 下载失败: 文件过大：超过上限 67108864 字节，已中止");
  expect(fs.readdirSync(root)).toEqual([]);
});
