import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { downloadFileTool } from "./builtin-tools/download-file-tool";

import * as fs from "fs";
import * as path from "path";
import * as os from "node:os";
import type { ToolContext } from "./registry/tool-context";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), lstatSync: vi.fn(actual.lstatSync) };
});

let directory: string;
let network = vi.fn();
const execute = (args: Record<string, unknown>) => downloadFileTool.execute(args, { userQuery: "Save this resource", resolvedWorkspaceRoot: directory });
beforeEach(() => {
  vi.mocked(fs.realpathSync).mockReset();
  vi.mocked(fs.lstatSync).mockReset();
  directory = mkdtempSync(join(tmpdir(), "download-contract-73-"));
  network = vi.fn();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  const target = resolve(directory);
  if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { force: true, recursive: true });
});

describe("download input safety before any request", () => {
  it.each([
    [{ url: "ftp://assets.example/chart.png" }, "[错误] url 必须以 http:// 或 https:// 开头"],
    [{ url: "https://assets.example/chart.png", filename: "../escape.png" }, "[错误] 路径不合法（禁止目录穿越或绝对路径）: ../escape.png"],
    [{ url: "https://assets.example/chart.png", filename: "/outside/chart.png" }, "[错误] 路径不合法（禁止目录穿越或绝对路径）: /outside/chart.png"],
    [{ url: "https://assets.example/installer.exe" }, "[错误] 禁止下载可执行/脚本文件: .exe"],
    [{ url: "https://assets.example/chart.png", filename: "chart|invalid.png" }, '[错误] filename 含非法字符（<>:"|?*）'],
  ] as const)("rejects %j before fetching", async (args, diagnostic) => {
    await expect(execute(args)).resolves.toEqual(diagnostic);
    expect(network).not.toHaveBeenCalled();
  });
});
describe("downloaded artifact behavior", () => {
  it("infers a URL filename without its query and saves all binary bytes", async () => {
    const bytes = Uint8Array.of(137, 80, 78, 71, 42, 73, 91, 0);
    network.mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/png" } }));
    expect(await execute({ url: "https://assets.example/maps/sky.png?revision=73" }))
      .toEqual(`[download_file] 已保存：${join(directory, "sky.png")}（0 KiB）`);
    expect(readFileSync(join(directory, "sky.png"))).toEqual(Buffer.from(bytes));
  });
  it("creates parent directories for an explicit relative filename", async () => {
    network.mockResolvedValue(new Response("Observation log", { headers: { "content-type": "text/plain" } }));
    expect(await execute({ url: "https://assets.example/resource?index=73", filename: "observations/night.txt" })).toContain("[download_file] 已保存");
    expect(readFileSync(join(directory, "observations/night.txt"), "utf8")).toBe("Observation log");
  });
  it("adds the JPEG suffix when only Content-Type identifies the format", async () => {
    network.mockResolvedValue(new Response(Uint8Array.of(4, 73), { headers: { "content-type": "image/jpeg" } }));
    const expected = join(directory, "download.jpg");
    expect(await execute({ url: "https://assets.example/image?id=73" })).toContain(expected);
    expect(existsSync(expected)).toBe(true);
  });
  it("requires a filename when neither URL nor MIME type supplies an extension", async () => {
    network.mockResolvedValue(new Response("unknown format", { headers: { "content-type": "application/octet-stream" } }));
    expect(await execute({ url: "https://assets.example/resource?id=73" })).toContain("[错误] 无法确定文件扩展名");
  });
  it("reports an unsuccessful HTTP response verbatim", async () => {
    network.mockResolvedValue(new Response("Unavailable", { status: 404, statusText: "Not Found" }));
    expect(await execute({ url: "https://assets.example/absent.png" })).toEqual("[错误] HTTP 404 Not Found");
  });
});

describe("download hardening", () => {
  function makeCtx(): ToolContext {
    return { userQuery: "Save this resource", resolvedWorkspaceRoot: directory };
  }
  async function mockResolvedLink(linked: string, target: string) {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    vi.mocked(fs.realpathSync).mockImplementation(((p: fs.PathLike) =>
      String(p) === linked ? actual.realpathSync(target) : actual.realpathSync(p)) as typeof fs.realpathSync);
    vi.mocked(fs.lstatSync).mockImplementation(((p: fs.PathLike) =>
      actual.lstatSync(String(p) === linked ? target : p)) as typeof fs.lstatSync);
  }

  it("rejects an inferred filename collision without changing the existing file", async () => {
    const target = path.join(directory, "report.pdf");
    fs.writeFileSync(target, "original");
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("replacement"));
    const result = await downloadFileTool.execute({ url: "https://example.com/report.pdf" }, makeCtx());
    expect(result).toContain("已存在");
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });

  it("rejects a resolved junction to an outside directory even when descendants do not exist", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-dl-outside-"));
    try {
      // Model the OS resolution seam: managed Windows sandboxes cannot create junctions.
      const linked = path.join(directory, "linked");
      await mockResolvedLink(linked, outside);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("replacement"));
      const result = await downloadFileTool.execute({ url: "https://example.com/a.txt", filename: "linked/new/a.txt" }, makeCtx());
      expect(result).toContain("路径不合法");
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(outside, "new/a.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks a loopback URL before making a request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("secret"));
    const result = await downloadFileTool.execute({ url: "http://127.0.0.1/a.txt" }, makeCtx());
    expect(result).toContain("[错误]");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects a collision after inferring the extension from Content-Type", async () => {
    fs.writeFileSync(path.join(directory, "download.jpg"), "original");
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("replacement", { headers: { "content-type": "image/jpeg" } }));
    expect(await downloadFileTool.execute({ url: "https://example.com/photo" }, makeCtx())).toContain("已存在");
    expect(fs.readFileSync(path.join(directory, "download.jpg"), "utf8")).toBe("original");
  });

  it("checks containment of the extension-derived final path", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-dl-outside-"));
    try {
      const target = path.join(outside, "original.jpg");
      fs.writeFileSync(target, "original");
      await mockResolvedLink(path.join(directory, "download.jpg"), target);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("replacement", { headers: { "content-type": "image/jpeg" } }));
      expect(await downloadFileTool.execute({ url: "https://example.com/photo" }, makeCtx())).toContain("路径不合法");
      expect(fs.readFileSync(target, "utf8")).toBe("original");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a resolved directory link that stays inside the workspace", async () => {
    const real = path.join(directory, "real");
    fs.mkdirSync(real);
    await mockResolvedLink(path.join(directory, "linked"), real);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("contents"));
    const result = await downloadFileTool.execute({ url: "https://example.com/a.txt", filename: "linked/new/a.txt" }, makeCtx());
    expect(result).toContain("[download_file] 已保存");
    expect(fs.readFileSync(path.join(real, "new/a.txt"), "utf8")).toBe("contents");
  });

  it("revalidates directory resolution after network I/O", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-dl-outside-"));
    fs.mkdirSync(path.join(directory, "images"));
    try {
      globalThis.fetch = vi.fn(async () => {
        await mockResolvedLink(path.join(directory, "images"), outside);
        return new Response("replacement");
      }) as typeof fetch;
      expect(await downloadFileTool.execute({ url: "https://example.com/a.txt", filename: "images/a.txt" }, makeCtx())).toContain("路径不合法");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("pins the original workspace root if its alias changes during the request", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-dl-outside-"));
    try {
      globalThis.fetch = vi.fn(async () => {
        await mockResolvedLink(directory, outside);
        return new Response("replacement");
      }) as typeof fetch;
      expect(await downloadFileTool.execute({ url: "https://example.com/a.txt" }, makeCtx())).toContain("路径不合法");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("uses exclusive creation if the destination appears during the download", async () => {
    const target = path.join(directory, "a.txt");
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) {
        fs.writeFileSync(target, "racing writer");
        controller.enqueue(new TextEncoder().encode("replacement"));
        controller.close();
      },
    }, { highWaterMark: 0 })));
    expect(await downloadFileTool.execute({ url: "https://example.com/a.txt" }, makeCtx())).toContain("已存在");
    expect(fs.readFileSync(target, "utf8")).toBe("racing writer");
  });

  it("cancels an oversized stream without writing a partial file", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
    }, { highWaterMark: 0 })));
    expect(await downloadFileTool.execute({ url: "https://example.com/a.txt" }, makeCtx())).toContain("文件过大");
    expect(chunks).toBe(65);
    expect(cancel).toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("cancels a declared oversized response without reading its body", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { "content-length": String(64 * 1024 * 1024 + 1) },
    }));
    expect(await downloadFileTool.execute({ url: "https://example.com/a.txt" }, makeCtx())).toContain("文件过大");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
