// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

it("shows every sticker, grouped into Firefly's own, the chat box ones and hand-added ones", async () => {
  document.body.innerHTML = '<section id="sticker-grid"></section><button id="min-btn"></button><button id="close-btn"></button>';
  const items = [
    { id: "firefly-wink", src: "/stickers/wink.png", enabled: true, builtIn: true },
    { id: "firefly-hug", src: "/stickers/hug.png", enabled: true, builtIn: true },
    { id: "firefly-cry", src: "/stickers/cry.png", enabled: false, builtIn: true },
    { id: "mine", src: "firefly-sticker://mine.png", enabled: true, builtIn: false },
  ];
  (window as { stickerManager?: unknown }).stickerManager = { getConfig: vi.fn(async () => items), setEnabled: vi.fn(), minimize: vi.fn(), close: vi.fn() };
  await import("./main");
  await vi.waitFor(() => expect(document.querySelectorAll(".sticker-card")).toHaveLength(4));
  expect([...document.querySelectorAll(".sticker-group__title")].map(node => node.textContent))
    .toEqual(["流萤会自动发送 · 1", "对话框里可以发送 · 2", "自己添加的 · 1"]);
  expect(document.querySelectorAll(".sticker-card.is-disabled")).toHaveLength(1);
  // Each group folds from its heading and stays folded on this device.
  const auto = document.querySelector<HTMLElement>('[data-group="auto"]')!;
  const toggle = auto.querySelector<HTMLButtonElement>(".sticker-group__title")!;
  expect(auto.hasAttribute("data-open")).toBe(true);
  toggle.click();
  expect(auto.hasAttribute("data-open")).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(JSON.parse(localStorage.getItem("firefly.stickerManager.folded")!)).toEqual(["auto"]);
});
