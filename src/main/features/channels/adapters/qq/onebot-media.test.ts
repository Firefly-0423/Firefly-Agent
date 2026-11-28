import { afterEach, beforeEach, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OneBotActionClient } from "./onebot-action-client";
import { OneBotActionError } from "./onebot-action-client";
import { OneBotMediaManager, versionAtLeast, ONEBOT_CACHE_TTL_MS, ONEBOT_MAX_FILE_BYTES, ONEBOT_BASE64_THRESHOLD_BYTES } from "./onebot-media";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), "qq-media-contract-")); });
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(directory, { recursive: true, force: true }); });
const chunk = (index: number, text: string) => ({
  type: "stream", data_type: "file_chunk", index, data: Buffer.from(text).toString("base64"), size: Buffer.byteLength(text),
});
function streamed(file_size: number, chunk_size: number, chunks: ReturnType<typeof chunk>[], total_chunks = chunks.length, total_bytes = file_size) {
  const client = { callStream: vi.fn(async (_action, _params, receive) => {
    await receive({ type: "stream", data_type: "file_info", file_name: "catalog.bin", chunk_size, file_size });
    for (const packet of chunks) await receive(packet);
    return { type: "response", data_type: "file_complete", total_chunks, total_bytes };
  }) } as unknown as OneBotActionClient;
  return new OneBotMediaManager(() => client, directory);
}
const download = (manager: OneBotMediaManager) => manager.downloadSegment({ type: "file", data: { file_id: "catalog-resource" } }, true);

it.each([["4.8.115", true], ["NapCat 4.19.2", true], ["4.8.104", false]])("compares NapCat release %s to the stream minimum", (version, expected) => {
  expect(versionAtLeast(version as string, "4.8.115")).toEqual(expected);
});

it("reconstructs out-of-order chunks using their advertised offsets", async () => {
  const attachment = await download(streamed(8, 4, [chunk(1, "EFGH"), chunk(0, "ABCD")]));
  expect(fs.readFileSync(attachment.filePath!, "utf8")).toEqual("ABCDEFGH");
});

it.each([
  ["zero chunk size", 8, 0, [], 0, 8, /chunk_size/],
  ["sparse indexes", 12, 4, [chunk(0, "ABCDEFGH"), chunk(2, "IJKL")], 2, 12, /not contiguous/],
  ["out-of-range offset", 8, 4, [chunk(6, "ABCD")], 1, 4, /offset exceeds file size/],
  ["missing bytes", 8, 4, [chunk(0, "ABCD")], 2, 8, /byte count mismatch/],
] as const)("rejects %s in a streamed download", async (_name, size, block, chunks, count, total, error) => {
  await expect(download(streamed(size, block, [...chunks], count, total))).rejects.toThrow(error);
});

it("embeds small outbound images as base64", async () => {
  const file = join(directory, "catalog.png");
  fs.writeFileSync(file, "image-contract-content");
  await expect(new OneBotMediaManager(() => null, directory).encodeOutbound(file, "image", false))
    .resolves.toEqual("base64://" + Buffer.from("image-contract-content").toString("base64"));
});

it("streams a small URL response into the local media cache", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("remote-image-contract")));
  const attachment = await new OneBotMediaManager(() => null, directory).downloadSegment({
    type: "image", data: { url: "http://127.0.0.1:9/catalog.png" },
  }, false);
  expect(fs.readFileSync(attachment.filePath!, "utf8")).toEqual("remote-image-contract");
});

it("rejects an oversized chunked URL response and leaves no partial cached file", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(ONEBOT_BASE64_THRESHOLD_BYTES + 1)); controller.close(); },
  }))));
  const manager = new OneBotMediaManager(() => null, directory);
  await expect(manager.downloadSegment({ type: "image", data: { url: "http://127.0.0.1:9/catalog.png" } }, false)).rejects.toThrow(/8 MiB/);
  expect(fs.readdirSync(directory)).toStrictEqual([]);
});

it("uploads chunks, supplies integrity metadata and accepts a matching completion hash", async () => {
  const file = join(directory, "catalog-upload.bin");
  fs.writeFileSync(file, "catalog-upload-data");
  let digest = "";
  const call = vi.fn(async (_action: string, params: Record<string, unknown>) => {
    if (params.is_complete) return { status: "file_complete", file_path: "/srv/media/catalog-upload.bin", sha256: digest };
    digest = String(params.expected_sha256);
    expect(params).toMatchObject({ filename: "catalog-upload.bin", chunk_index: 0, total_chunks: 1, file_size: 19 });
    return { status: "chunk_received" };
  });
  const client = { call } as unknown as OneBotActionClient;
  await expect(new OneBotMediaManager(() => client, directory).encodeOutbound(file, "file", true))
    .resolves.toEqual("/srv/media/catalog-upload.bin");
  expect(call).toHaveBeenCalledTimes(2);
});

it("deletes cache entries older than the retention window", async () => {
  const stale = join(directory, "stale-resource.bin");
  fs.writeFileSync(stale, "expired fixture");
  const timestamp = new Date(Date.now() - ONEBOT_CACHE_TTL_MS - 2000);
  fs.utimesSync(stale, timestamp, timestamp);
  await new OneBotMediaManager(() => null, directory).cleanupCache();
  expect(fs.existsSync(stale)).toEqual(false);
});

it("notifies runtime downgrade logic when the remote stream action is unavailable", async () => {
  const onUnavailable = vi.fn();
  const client = { callStream: vi.fn(async () => { throw new OneBotActionError("operation not found", 1404); }) } as unknown as OneBotActionClient;
  const manager = new OneBotMediaManager(() => client, directory, onUnavailable);
  await expect(manager.downloadSegment({ type: "image", data: { file: "catalog-image" } }, true)).rejects.toThrow("operation not found");
  expect(onUnavailable).toHaveBeenCalledTimes(1);
});

it("refuses outbound files one byte above the hundred-MiB limit", async () => {
  const file = join(directory, "oversized-resource.bin");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, ONEBOT_MAX_FILE_BYTES + 1);
  await expect(new OneBotMediaManager(() => null, directory).encodeOutbound(file, "file", true)).rejects.toThrow(/100 MiB/);
});
