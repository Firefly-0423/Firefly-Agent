import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import { ILinkClient, type WeixinMessage, type CDNMedia } from "./ilink-protocol-client";
import { ChannelManager } from "../../manager";
import { requireChannelMemoryIngress, type ChannelMemoryIngress } from "../../../memory-context/channel-memory-ingress";
import type { IncomingMessage, OutgoingPart } from "../../types";

const host = vi.hoisted(() => ({
  directory: "", uploadFile: vi.fn(), uploadData: vi.fn(), download: vi.fn(), encode: vi.fn(),
  asrStart: vi.fn(), asrAudio: vi.fn(), asrStop: vi.fn(), asrCancel: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => host.directory } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ wechat: { enabled: true, allowAnyPrivate: true, allowedSenderIds: [] } }) }));
vi.mock("./wechat-media-upload", () => ({ uploadWechatMediaFile: host.uploadFile, uploadWechatMedia: host.uploadData }));
vi.mock("./wechat-media-download", () => ({ downloadWechatMedia: host.download }));
vi.mock("./wechat-voice-encoding", () => ({ encodeWechatVoiceSilk: host.encode }));
vi.mock("../../../asr/asr-config", () => ({ getAsrConfig: () => ({ engine: "mossland", apiKey: "contract-asr-key" }) }));
vi.mock("../../../asr/asr-dispatcher", () => ({ createAsrStream: () => ({
  start: host.asrStart, sendAudio: host.asrAudio, stop: host.asrStop, cancel: host.asrCancel,
}) }));

const media: CDNMedia = { encrypt_query_param: "contract-cdn-query", aes_key: "contract-key", encrypt_type: 1 };
let adapter: ILinkBotAdapter;
let manager: ChannelManager;
let received: ReturnType<typeof vi.fn>;
let sendText: ReturnType<typeof vi.spyOn>;
let sendMessage: ReturnType<typeof vi.spyOn>;
let receivePoll: ((messages: WeixinMessage[]) => void) | undefined;
let ingress: ChannelMemoryIngress | undefined;
let sequence = 0;
function inbound(content = "", items: WeixinMessage["items"] = [], contextToken = "reply-contract", msgId = `incoming-${++sequence}`): WeixinMessage {
  return { msgId, fromUserId: "wx-contract-reader", toUserId: "contract-bot", msgType: 1, content, items, contextToken, raw: {} };
}
async function deliver(message: WeixinMessage) {
  await vi.waitFor(() => expect(receivePoll).toBeDefined());
  const resolve = receivePoll!;
  receivePoll = undefined;
  resolve([message]);
  await vi.waitFor(() => expect(receivePoll).toBeDefined());
}
function send(parts: OutgoingPart[]) { return adapter.send({ channel: "wechat", targetId: "wx-contract-reader", parts }); }
function encoded(file: string): CDNMedia {
  return { encrypt_query_param: "uploaded:" + file, aes_key: "contract-upload-key", encrypt_type: 1 };
}

beforeEach(async () => {
  vi.clearAllMocks();
  sequence = 0; receivePoll = undefined; ingress = undefined;
  host.directory = fs.mkdtempSync(join(tmpdir(), "ilink-behavior-contract-"));
  fs.mkdirSync(join(host.directory, "weixin"));
  fs.writeFileSync(join(host.directory, "weixin", "credentials.json"), JSON.stringify({
    botToken: "contract-bot-token", ilinkBotId: "contract-bot", baseUrl: "https://ilink.invalid", ilinkUserId: "contract-owner",
  }));
  fs.writeFileSync(join(host.directory, "app-settings.json"), JSON.stringify({ asrEngine: "local" }));
  vi.spyOn(ILinkClient.prototype, "getUpdates").mockImplementation(async (_cursor, signal) => {
    return new Promise(resolve => {
      receivePoll = messages => resolve({ messages, buf: "next-contract-cursor" });
      signal?.addEventListener("abort", () => resolve({ messages: [], buf: "" }), { once: true });
    });
  });
  sendText = vi.spyOn(ILinkClient.prototype, "sendText").mockResolvedValue({ ok: true });
  sendMessage = vi.spyOn(ILinkClient.prototype, "sendMessage").mockResolvedValue({ ok: true });
  host.uploadFile.mockImplementation(async (_client, _user, file: string) => encoded(file));
  host.uploadData.mockImplementation(async (_client, _user, bytes: Buffer) => encoded(bytes.toString()));
  host.download.mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 65, 66]));
  host.encode.mockResolvedValue({ data: Buffer.from("contract-silk"), durationMs: 1800, sampleRate: 24000, encodeType: 6 });
  host.asrStart.mockResolvedValue(undefined);
  host.asrStop.mockResolvedValue("请检查日程安排");
  received = vi.fn(async (_message: IncomingMessage) => null);
  adapter = new ILinkBotAdapter();
  manager = new ChannelManager();
  manager.register(adapter);
  manager.setDispatcher(async (message, capability) => { ingress = capability; return received(message); });
  await manager.startOne("wechat");
  await deliver(inbound("Establish reply context"));
  received.mockClear();
});

afterEach(async () => {
  await manager.stopAll();
  vi.restoreAllMocks();
  fs.rmSync(host.directory, { force: true, recursive: true });
});

it("uses the inbound context token for a text response", async () => {
  expect(await send([{ kind: "text", text: "Review acknowledged" }])).toStrictEqual({ ok: true });
  expect(sendText).toHaveBeenCalledWith("wx-contract-reader", "Review acknowledged", "reply-contract");
});

it("sends trimmed text parts as separate messages in input order", async () => {
  expect(await send([
    { kind: "text", text: "First observation." }, { kind: "text", text: "Next question?" }, { kind: "text", text: "\nFinal note!" },
  ])).toStrictEqual({ ok: true });
  expect(sendText.mock.calls).toStrictEqual([
    ["wx-contract-reader", "First observation.", "reply-contract"],
    ["wx-contract-reader", "Next question?", "reply-contract"],
    ["wx-contract-reader", "Final note!", "reply-contract"],
  ]);
});

it("uploads local images and stickers and sends distinct image-item payloads after text", async () => {
  const chart = join(host.directory, "chart.png");
  const sticker = join(host.directory, "celebrate.png");
  expect(await send([{ kind: "text", text: "Charts follow" }, { kind: "image", filePath: chart, caption: "Chart" },
    { kind: "sticker", stickerId: "celebrate", imagePath: sticker }])).toStrictEqual({ ok: true });
  expect(sendText).toHaveBeenCalledWith("wx-contract-reader", "Charts follow", "reply-contract");
  expect(host.uploadFile).toHaveBeenCalledTimes(2);
  expect(host.uploadFile).toHaveBeenNthCalledWith(1, expect.anything(), "wx-contract-reader", chart, 1);
  expect(host.uploadFile).toHaveBeenNthCalledWith(2, expect.anything(), "wx-contract-reader", sticker, 1);
  expect(sendMessage.mock.calls).toStrictEqual([
    ["wx-contract-reader", [{ type: 2, image_item: { media: encoded(chart) } }], "reply-contract"],
    ["wx-contract-reader", [{ type: 2, image_item: { media: encoded(sticker) } }], "reply-contract"],
  ]);
});

it("uses the protocol file and video item shapes and upload type codes", async () => {
  const document = join(host.directory, "brief.pdf");
  const clip = join(host.directory, "walkthrough.mp4");
  expect(await send([{ kind: "file", filePath: document, name: "brief.pdf", mime: "application/pdf" },
    { kind: "video", filePath: clip, name: "walkthrough.mp4", mime: "video/mp4" }])).toStrictEqual({ ok: true });
  expect(host.uploadFile).toHaveBeenNthCalledWith(1, expect.anything(), "wx-contract-reader", document, 3);
  expect(host.uploadFile).toHaveBeenNthCalledWith(2, expect.anything(), "wx-contract-reader", clip, 2);
  expect(sendMessage.mock.calls).toStrictEqual([
    ["wx-contract-reader", [{ type: 4, file_item: { file_name: "brief.pdf", media: encoded(document) } }], "reply-contract"],
    ["wx-contract-reader", [{ type: 5, video_item: { media: encoded(clip) } }], "reply-contract"],
  ]);
});

it.each([true, false])("encodes WAV voice and preserves successful text when voice delivery succeeds=%s", async successful => {
  const file = join(host.directory, "voice.wav");
  const bytes = Buffer.from("contract-wav-source");
  fs.writeFileSync(file, bytes);
  if (!successful) sendMessage.mockResolvedValue({ ok: false, error: "voice delivery refused" });
  expect(await send([{ kind: "text", text: "Voice report follows" }, { kind: "audio", filePath: file, mime: "audio/wav" }]))
    .toStrictEqual({ ok: true });
  expect(sendText).toHaveBeenCalledWith("wx-contract-reader", "Voice report follows", "reply-contract");
  expect(host.encode).toHaveBeenCalledWith(bytes, { format: "wav" });
  expect(host.uploadData).toHaveBeenCalledWith(expect.anything(), "wx-contract-reader", Buffer.from("contract-silk"), 4);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith("wx-contract-reader", [{
    type: 3, voice_item: { media: encoded("contract-silk"), encode_type: 6, sample_rate: 24000, playtime: 1800 },
  }], "reply-contract");
});

it("downloads supported images into a local incoming attachment", async () => {
  await deliver(inbound("Inspect the chart", [{ type: 2, image_item: { media } }]));
  expect(host.download).toHaveBeenCalledWith(expect.objectContaining(media));
  expect(received).toHaveBeenCalledWith(expect.objectContaining({
    channel: "wechat", senderId: "wx-contract-reader", text: "Inspect the chart",
    attachments: [{ kind: "image", filePath: expect.any(String), mime: "image/png", caption: "微信图片" }],
  }));
  const attachment = received.mock.calls[0][0].attachments[0];
  expect(fs.readFileSync(attachment.filePath)).toStrictEqual(await host.download.mock.results[0].value);
});

it("reports a supported attachment download failure without dispatching it", async () => {
  host.download.mockRejectedValue(new Error("CDN unreachable"));
  await deliver(inbound("Inspect the chart", [{ type: 2, image_item: { media } }]));
  expect(sendText).toHaveBeenCalledWith("wx-contract-reader", expect.stringContaining("微信附件下载失败"), "reply-contract");
  expect(received).not.toHaveBeenCalled();
});

it("saves a pending unsupported file after a subsequent save request", async () => {
  await deliver(inbound("", [{ type: 4, file_item: { file_name: "catalog.zip", media } }], "file-context", "pending-catalog"));
  await deliver(inbound("请保存到桌面", [], "save-context"));
  const inbox = join(host.directory, "Firefly 收件箱");
  const files = fs.readdirSync(inbox);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/pending-catalog.*catalog\.zip$/);
  expect(sendText).toHaveBeenLastCalledWith("wx-contract-reader",
    "伙伴，文件已保存到桌面的“Firefly 收件箱”：" + join(inbox, files[0]), "save-context");
  expect(received).not.toHaveBeenCalled();
});

it.each([["video", "walkthrough.mp4"], ["file", "brief.pdf"]] as const)(
  "saves a %s arriving after save intent instead of dispatching it for analysis", async (kind, name) => {
    await deliver(inbound("请帮我代收", [], "intent-context"));
    expect(sendText).toHaveBeenNthCalledWith(1, "wx-contract-reader",
      "嗯，伙伴，请把文件发过来。我会帮你放到桌面的“Firefly 收件箱”。", "intent-context");
    const item = kind === "video" ? { type: 5 as const, video_item: { file_name: name, media } }
      : { type: 4 as const, file_item: { file_name: name, media } };
    await deliver(inbound("", [item], "media-context", "save-requested"));
    const inbox = join(host.directory, "Firefly 收件箱");
    const files = fs.readdirSync(inbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("save-requested");
    expect(files[0]).toContain(name);
    expect(sendText).toHaveBeenLastCalledWith("wx-contract-reader",
      "伙伴，文件已保存到桌面的“Firefly 收件箱”：" + join(inbox, files[0]), "media-context");
    expect(fs.existsSync(join(host.directory, "channels", "cache"))).toEqual(false);
    expect(received).not.toHaveBeenCalled();
  },
);

it("dispatches ASR text with an ingress capability tied to the exact transformed message", async () => {
  await deliver(inbound("", [{ type: 3, voice_item: { media, sample_rate: 16000 } }], "voice-context"));
  expect(host.asrAudio).toHaveBeenCalledWith(expect.any(Buffer));
  expect(sendText).not.toHaveBeenCalled();
  expect(received).toHaveBeenCalledWith(expect.objectContaining({
    channel: "wechat", senderId: "wx-contract-reader", text: "请检查日程安排", attachments: undefined,
  }));
  const transformed = received.mock.calls[0][0];
  expect(requireChannelMemoryIngress(ingress, transformed).provenance).toEqual("asr");
  expect(() => requireChannelMemoryIngress(ingress, { ...transformed })).toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
});

it("responds with the exact ASR failure explanation without dispatching voice", async () => {
  host.asrStop.mockRejectedValue(new Error("recognizer unavailable"));
  await deliver(inbound("", [{ type: 3, voice_item: { media, sample_rate: 16000 } }], "voice-context"));
  expect(sendText).toHaveBeenCalledWith("wx-contract-reader",
    "伙伴，这条语音我暂时没听清楚：recognizer unavailable。可以换成文字再发我一次。", "voice-context");
  expect(received).not.toHaveBeenCalled();
});
