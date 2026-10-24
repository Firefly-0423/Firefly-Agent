import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
const sdk = vi.hoisted(() => ({
  send: vi.fn(), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), on: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu" }, LoggerLevel: { warn: "warn" }, createLarkChannel: () => sdk,
}));
vi.mock("../../settings-store", () => ({
  loadChannelsSettings: () => ({ feishu: { enabled: true, appId: "cli_media_contract", appSecret: "fixture-credential" } }),
}));
import { FeishuAdapter, transcodeAudioFileToFeishuOpus } from "./index";

let directory: string;
let adapter: FeishuAdapter;
beforeEach(async () => {
  vi.clearAllMocks();
  sdk.send.mockResolvedValue({ messageId: "receipt-contract-8" });
  directory = fs.mkdtempSync(join(tmpdir(), "feishu-media-contract-"));
  adapter = new FeishuAdapter();
  await adapter.start();
});
afterEach(async () => {
  await adapter.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each([undefined, "renamed-brief.pdf"])("uploads a document using the SDK file name %s", async name => {
  const filePath = join(directory, "brief.pdf");
  expect(await adapter.send({ channel: "feishu", targetId: "oc_review", parts: [{ kind: "file", filePath, ...(name ? { name } : {}) }] }))
    .toStrictEqual({ ok: true });
  expect(sdk.send).toHaveBeenCalledWith("oc_review", { file: { source: filePath, fileName: name ?? "brief.pdf" } });
});

it("translates local video and sticker parts to SDK media payloads", async () => {
  const video = join(directory, "walkthrough.mp4");
  const sticker = join(directory, "celebrate.jpg");
  expect(await adapter.send({ channel: "feishu", targetId: "oc_review", parts: [
    { kind: "video", filePath: video }, { kind: "sticker", stickerId: "celebrate", imagePath: sticker },
  ] })).toStrictEqual({ ok: true });
  expect(sdk.send.mock.calls).toStrictEqual([
    ["oc_review", { video: { source: video } }], ["oc_review", { image: { source: sticker } }],
  ]);
});

it.each([null, undefined, {}, { messageId: "" }, { messageId: " " }])("rejects an unusable SDK delivery receipt %j", async receipt => {
  sdk.send.mockResolvedValue(receipt);
  expect(await adapter.send({ channel: "feishu", targetId: "oc_review", parts: [{ kind: "text", text: "Review update" }] }))
    .toMatchObject({ ok: false, error: expect.stringContaining("消息回执") });
  expect(sdk.send).toHaveBeenCalledTimes(1);
});

it("delegates Opus duration handling to the SDK without a duration field", async () => {
  const filePath = join(directory, "voice.opus");
  fs.writeFileSync(filePath, "OggS-contract-voice");
  expect(await adapter.send({ channel: "feishu", targetId: "oc_review", parts: [{ kind: "audio", filePath, mime: "audio/ogg" }] }))
    .toStrictEqual({ ok: true });
  expect(sdk.send).toHaveBeenCalledWith("oc_review", { audio: { source: filePath } });
});

it.each([true, false])("validates and cleans up transcoder output (valid=%s)", async valid => {
  const input = join(directory, "recording.wav");
  fs.writeFileSync(input, "RIFF-contract-voice");
  let output = "";
  const runMpv = vi.fn(async (_binary: string, arguments_: string[]) => {
    output = arguments_.find(argument => argument.startsWith("--o="))!.slice(4);
    fs.writeFileSync(output, valid ? "OggS-contract-voice" : "invalid voice header");
  });
  const conversion = transcodeAudioFileToFeishuOpus(input, { resolveMpvBinary: () => "D:/tools/mpv.exe", runMpv });
  if (valid) {
    const file = await conversion;
    expect(fs.readFileSync(file).subarray(0, 4).toString("ascii")).toEqual("OggS");
    expect(extname(file)).toEqual(".opus");
    expect(runMpv).toHaveBeenCalledTimes(1);
    expect(runMpv).toHaveBeenCalledWith("D:/tools/mpv.exe", [
      "--no-config", "--no-video", "--really-quiet", "--o=" + file, "--of=opus", "--oac=libopus",
      "--audio-channels=mono", "--audio-samplerate=48000", input,
    ]);
  } else {
    await expect(conversion).rejects.toThrow("不是有效的 Ogg Opus 音频");
    expect(fs.existsSync(output)).toEqual(false);
  }
});
