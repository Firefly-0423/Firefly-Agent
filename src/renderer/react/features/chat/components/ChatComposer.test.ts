import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const capture = vi.hoisted(() => ({ sender: {} as Record<string, any> }));
vi.mock("@ant-design/x", () => ({ Sender: (props: Record<string, unknown>) => { capture.sender = props; return null; } }));
vi.mock("antd", () => ({ Popover: ({ children }: { children?: React.ReactNode }) => children, Segmented: () => null }));
vi.mock("./DesktopAsrButton", () => ({ DesktopAsrButton: () => null }));
vi.mock("./PermissionControl", () => ({ PermissionControl: () => null }));
vi.mock("./ModelEffortControl", () => ({ ModelEffortControl: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
import { ChatComposer, composerAddMenuEntries, parseComposerMessage, pickableStickers, splitStickerMarkers } from "./ChatComposer";

afterEach(() => vi.unstubAllGlobals());
const draw = (patch: Partial<React.ComponentProps<typeof ChatComposer>> = {}) => {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(ChatComposer, {
    mode: "chat", value: "", docked: true, attachments: [], onChange: vi.fn(), onSubmit: vi.fn(),
    onChooseWorkspace: vi.fn(), onChooseFiles: vi.fn(), onRemoveAttachment: vi.fn(),
    onScreenshot: vi.fn(), onChooseSticker: vi.fn(), ...patch,
  }));
};

test("retains the stop handler while a workspace label is unavailable", () => {
  const cancel = vi.fn();
  draw({ modelBusy: true, onCancel: cancel });
  expect(capture.sender.onCancel).toBe(cancel);
  draw({ modelBusy: true, mode: "work", onCancel: cancel });
  expect(capture.sender.disabled).toBe(false);
});

test("Code has an add menu but no sticker sending or plan toggle", () => {
  expect(composerAddMenuEntries(true)).toStrictEqual(["upload", "screenshot", "sticker"]);
  expect(composerAddMenuEntries(false)).toStrictEqual(["upload", "screenshot"]);
  draw({ mode: "code", workspaceName: "Studio", conversationId: "coding-desk" });
  const prefix = renderToStaticMarkup(capture.sender.prefix);
  expect(prefix).toContain('aria-label="添加"');
  for (const removed of ["计划模式", "ff-plan-control"]) expect(prefix).not.toContain(removed);
  expect(parseComposerMessage("code", "  review patch [sticker:celebrate]  "))
    .toStrictEqual({ visibleContent: "review patch", rawContent: "review patch", userSticker: undefined });
  expect(parseComposerMessage("work", "  review patch [sticker:celebrate]  "))
    .toStrictEqual({ visibleContent: "review patch", rawContent: "review patch [sticker:celebrate]", userSticker: "celebrate" });
});

test("uses a capsule only for an attachment-free docked draft", () => {
  expect(draw()).toContain("ff-composer-shell is-capsule");
  expect(draw({ docked: false })).not.toContain("is-capsule");
  expect(draw({ attachments: [{ kind: "document", name: "guide.txt", filePath: "guide.txt" }] })).not.toContain("is-capsule");
  expect(pickableStickers([{ id: "firefly-pout" }, { id: "custom-wave" }, { id: "firefly-tea" }]))
    .toStrictEqual([{ id: "custom-wave" }, { id: "firefly-tea" }]);
});

test("extracts known markers without losing their order or multiplicity", () => {
  const known = new Set(["wave", "smile"]);
  const separated = splitStickerMarkers("Greetings [sticker:wave]", known);
  expect(separated).toStrictEqual({ visible: "Greetings ", markers: ["[sticker:wave]"] });
  expect(separated.visible + separated.markers.join("")).toBe("Greetings [sticker:wave]");
  expect(splitStickerMarkers("[sticker:smile][sticker:smile]", known))
    .toStrictEqual({ visible: "", markers: ["[sticker:smile]", "[sticker:smile]"] });
  expect(splitStickerMarkers("A [sticker:obsolete] B", known))
    .toStrictEqual({ visible: "A [sticker:obsolete] B", markers: [] });
  expect(splitStickerMarkers("ordinary [brackets]", known))
    .toStrictEqual({ visible: "ordinary [brackets]", markers: [] });
  const markers = splitStickerMarkers("Draft[sticker:wave]", known).markers;
  for (const visible of ["Draft ", "Draft update", "", "Draft\n"]) {
    expect(splitStickerMarkers(visible + markers.join(""), known)).toStrictEqual({ visible, markers });
  }
});
