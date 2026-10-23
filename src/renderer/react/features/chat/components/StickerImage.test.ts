// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { StickerImage } from "./StickerImage";
import { isRetiredStickerRef } from "../../../../../shared/retired-stickers";

globalThis.React = React;
const container = document.createElement("div");
const root = createRoot(container);
afterEach(() => { act(() => root.render(null)); });

it("shows retired history explicitly without loading its missing file", () => {
  act(() => root.render(React.createElement(StickerImage, { src: "/stickers/playful.png", unavailable: "表情包已下架", alt: "贴图" })));
  expect(container.textContent).toBe("表情包已下架");
  expect(container.querySelector("img")).toBeNull();
  expect(isRetiredStickerRef("stickers/peek.gif")).toBe(true);
  expect(isRetiredStickerRef("local-sticker:///peek.gif")).toBe(false);
});

it("keeps GIF URLs animated and handles missing images without replacing content", () => {
  act(() => root.render(React.createElement(StickerImage, { src: "local-sticker:///public.gif", alt: "用户贴图" })));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("local-sticker:///public.gif");
  act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(container.textContent).toBe("表情包不可用");
  act(() => root.render(React.createElement(StickerImage, { src: "/stickers/hug.png", alt: "抱抱" })));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/stickers/hug.png");
});
