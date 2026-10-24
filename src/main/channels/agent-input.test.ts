import { expect, it, vi } from "vitest";
import { buildChannelAttachmentInputs } from "./agent-input";
import type { IncomingMessage } from "./types";

function incoming(): IncomingMessage {
  return { channel: "wechat", senderId: "wx-reader", chatId: "wx-reader", text: "Inspect the attachments", at: new Date(1000) };
}

it("routes photos as direct images and documents as file context", async () => {
  const envelope = incoming();
  envelope.attachments = [
    { kind: "image", filePath: "D:/inbox/diagram.png", mime: "image/png", caption: "流程图" },
    { kind: "file", filePath: "D:/inbox/agenda.pdf", mime: "application/pdf", caption: "agenda.pdf" },
  ];
  expect(await buildChannelAttachmentInputs(envelope, { imageMode: "direct" })).toStrictEqual({
    imageAttachments: [{ mime: "image/png", filePath: "D:/inbox/diagram.png", name: "流程图" }],
    attachments: [{ text: "用户通过微信发送了文件：D:/inbox/agenda.pdf", name: "agenda.pdf" }],
  });
});

it("turns a successful image caption into the exact model-visible context", async () => {
  const envelope = incoming();
  envelope.attachments = [{ kind: "image", filePath: "D:/inbox/map.png", mime: "image/png", caption: "路线图" }];
  const captionImage = vi.fn(async () => ({ ok: true, caption: "地图显示两条步行路线" }));
  expect(await buildChannelAttachmentInputs(envelope, { imageMode: "caption", captionImage })).toStrictEqual({
    imageAttachments: undefined,
    attachments: [{ name: "路线图", text: "【图片视觉信息】\n用户通过微信发送了图片：路线图\n地图显示两条步行路线" }],
  });
  expect(captionImage).toHaveBeenCalledExactlyOnceWith("D:/inbox/map.png");
});
