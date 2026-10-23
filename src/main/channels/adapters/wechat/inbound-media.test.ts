import { it, expect } from "vitest";
import { isAnalyzableWechatFile, describeInboundWechatMedia, isWechatSaveIntent, getWechatDisplayName,
  buildWechatSaveIntentPrompt, buildWechatVideoPrompt, buildUnsupportedWechatFilePrompt } from "./inbound-media";

it.each([
  ["brief.PDF", true], ["planning.md", true], ["service.log", true],
  ["bundle.zip", false], ["launcher.exe", false], ["walkthrough.mp4", false],
])("classifies analysis support for %s", (name, supported) => {
  expect(isAnalyzableWechatFile(name)).toEqual(supported);
});

it("describes document and video attachments in their original order", () => {
  expect(describeInboundWechatMedia([
    { type: 4, file_item: { file_name: "brief.pdf" } }, { type: 5, video_item: { file_name: "walkthrough.mp4" } },
  ])).toEqual([
    { analyzable: true, extension: ".pdf", fileName: "brief.pdf", kind: "file" },
    { analyzable: false, extension: ".mp4", fileName: "walkthrough.mp4", kind: "video" },
  ]);
});

it.each([["请保存到桌面", true], ["这个帮我代收一下", true], ["下午开会", false]])("detects save intent in %s", (text, expected) => {
  expect(isWechatSaveIntent(text)).toEqual(expected);
});

it("uses the preferred name or the default companion address", () => {
  expect(getWechatDisplayName("\t ")).toEqual("伙伴");
  expect(getWechatDisplayName("林同学")).toEqual("林同学");
});

it("preserves the exact save and unsupported-media prompts", () => {
  expect(buildWechatSaveIntentPrompt("伙伴")).toEqual("嗯，伙伴，请把文件发过来。我会帮你放到桌面的“Firefly 收件箱”。");
  expect(buildUnsupportedWechatFilePrompt("伙伴")).toEqual("伙伴，这个文件我暂时无法分析。如果你想让我代收，请在 5 分钟内回复“保存到桌面”。");
  expect(buildWechatVideoPrompt("林同学")).toEqual("林同学，视频我暂时还看不了。如果你想让我代收，请在 5 分钟内回复“保存到桌面”。");
});
