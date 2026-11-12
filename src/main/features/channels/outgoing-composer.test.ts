import { expect, it, vi } from "vitest";
import { buildTextOutgoingParts, downgradeToCapability, createOutgoingComposer } from "./outgoing-composer";
import type { ChannelCapability, OutgoingPart, OutgoingMessage, IncomingMessage } from "./types";

const capability = (change: Partial<ChannelCapability> = {}): ChannelCapability => ({
  maxTextLength: 4096, sticker: true, card: true, markdown: true, video: true, file: true, audio: true, image: true, text: true, ...change,
});
const message = (parts: OutgoingPart[]): OutgoingMessage => ({ channel: "feishu", targetId: "review-room", parts });
const inbound: IncomingMessage = { channel: "feishu", chatType: "private", senderId: "reviewer", chatId: "review-room", text: "Status?", at: new Date(2000) };

it("keeps a multi-sentence reply together", () => {
  expect(buildTextOutgoingParts("Draft received. Review next?")).toStrictEqual([{ text: "Draft received. Review next?", kind: "text" }]);
});

it("truncates only texts longer than a positive maximum and appends the exact notice", () => {
  expect(downgradeToCapability(message([{ kind: "text", text: "z".repeat(4800) }]), capability({ maxTextLength: 120 })).parts)
    .toStrictEqual([{ kind: "text", text: "z".repeat(100) + "\n...(过长已截断)" }]);
  for (const maxTextLength of [0, 1000]) {
    expect(downgradeToCapability(message([{ kind: "text", text: "z".repeat(1000) }]), capability({ maxTextLength })).parts)
      .toStrictEqual([{ text: "z".repeat(1000), kind: "text" }]);
  }
});

it("downgrades unsupported media into ordered explanatory text and omits stickers", () => {
  const parts: OutgoingPart[] = [
    { kind: "image", url: "https://media.invalid/chart.png", caption: "趋势图" }, { kind: "image" },
    { kind: "audio", filePath: "D:/media/note.mp3", mime: "audio/mpeg" },
    { kind: "file", filePath: "D:/media/brief.pdf", name: "brief.pdf" },
    { kind: "video", filePath: "D:/media/tour.mp4", name: "tour.mp4" },
    { kind: "card", title: "Forecast", markdown: "Clear 18°", fields: [{ key: "Wind", value: "12 km/h" }] },
    { kind: "text", text: "End of report" },
    { kind: "sticker", stickerId: "HAPPY", imagePath: "D:/media/happy.png" },
  ];
  const original = message(parts);
  const preserved = structuredClone(original);
  const result = downgradeToCapability(original, capability({ image: false, audio: false, file: false, video: false, card: false, sticker: false }));
  expect(result.parts).toStrictEqual([
    { text: "[图片] 趋势图", kind: "text" }, { text: "[图片] ", kind: "text" },
    { text: "[语音消息 audio/mpeg, 见桌面端]", kind: "text" },
    { text: "[文件] brief.pdf", kind: "text" }, { text: "[视频] tour.mp4", kind: "text" },
    { text: "Forecast\nClear 18°\nWind: 12 km/h", kind: "text" },
    { text: "End of report", kind: "text" },
  ]);
  expect(original).toStrictEqual(preserved);
  expect(downgradeToCapability(original, capability())).toStrictEqual(original);
});

it("leaves messages without a capability declaration untouched and preserves empty parts", () => {
  const original = message([{ kind: "text", text: "z".repeat(4800) }, { kind: "image", url: "https://media.invalid/picture.png" }]);
  expect(downgradeToCapability(original, undefined)).toStrictEqual(original);
  expect(downgradeToCapability(message([]), capability({ text: false })).parts).toStrictEqual([]);
});

it("continues removing temporary files after an individual removal fails", async () => {
  const removeFile = vi.fn(async (file: string) => { if (file === "locked.wav") throw new Error("file locked"); });
  const composer = createOutgoingComposer({ removeFile });
  await expect(composer.cleanupTransientFiles(["locked.wav", "removable.wav"])).resolves.toBeUndefined();
  expect(removeFile.mock.calls).toStrictEqual([["locked.wav"], ["removable.wav"]]);
});

it("attaches a persistent sticker without marking its image for cleanup", async () => {
  const composer = createOutgoingComposer({ resolveStickerImagePath: () => "D:/stickers/happy.png" });
  const prepared = await composer.compose({
    incoming: inbound, replyText: "Review complete", sticker: "HAPPY", capability: capability(), settings: { stickerEnabled: true },
  });
  expect(prepared.message.parts).toStrictEqual([
    { kind: "text", text: "Review complete" }, { kind: "sticker", stickerId: "HAPPY", imagePath: "D:/stickers/happy.png" },
  ]);
  expect(prepared.stickerId).toEqual("HAPPY");
  expect(prepared.transientFiles).toStrictEqual([]);
});

it("survives sticker lookup errors with text only and no temporary audio to clean", async () => {
  const removeFile = vi.fn(async () => {});
  const composer = createOutgoingComposer({
    removeFile, resolveStickerImagePath: () => { throw new Error("sticker directory inaccessible"); },
  });
  const prepared = await composer.compose({
    incoming: inbound, replyText: "Review complete", sticker: "HAPPY", capability: capability(), settings: { stickerEnabled: true },
  });
  expect(prepared.message.parts).toStrictEqual([{ kind: "text", text: "Review complete" }]);
  expect(prepared.stickerId).toBeUndefined();
  expect(prepared.transientFiles).toStrictEqual([]);
  await composer.cleanupTransientFiles(prepared.transientFiles);
  expect(removeFile).not.toHaveBeenCalled();
});

it("does not commit a sticker identifier when the channel cannot deliver stickers", async () => {
  const prepared = await createOutgoingComposer({ resolveStickerImagePath: () => "D:/stickers/happy.png" }).compose({
    incoming: inbound, replyText: "Review complete", sticker: "HAPPY", capability: capability({ sticker: false }), settings: { stickerEnabled: true },
  });
  expect(prepared.message.parts).toStrictEqual([{ text: "Review complete", kind: "text" }]);
  expect(prepared.stickerId).toBeUndefined();
});
