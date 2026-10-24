// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FeedbackApi } from "../../../shared/feedback-types";

const ports = vi.hoisted(() => ({ notice: vi.fn(), dialog: vi.fn() }));
vi.mock("antd", () => ({
  Modal: { useModal: () => [{ confirm: ports.dialog }, null] },
  message: { useMessage: () => [{ open: ports.notice }, null] },
}));
import { FeedbackProvider, useFeedback } from "./FeedbackProvider";

let root: Root;
let feedback: FeedbackApi;
beforeEach(async () => {
  ports.notice.mockReset();
  ports.dialog.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("section"));
  function Consumer() { feedback = useFeedback(); return null; }
  await act(async () => root.render(createElement(FeedbackProvider, null, createElement(Consumer))));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test("forwards notice identity, presentation and duration with optional focus", () => {
  feedback.notice({ tone: "success", message: "Workspace saved" });
  expect(ports.notice.mock.calls).toStrictEqual([[{
    key: "success:Workspace saved", type: "success", content: "Workspace saved",
    duration: 3, className: "ff-feedback-notice",
  }]]);
  const focusTarget = { focus: vi.fn() };
  feedback.notice({ tone: "warning", message: "Retry needed", durationMs: 1750, focusTarget });
  expect(focusTarget.focus).toHaveBeenCalledTimes(1);
  expect(ports.notice).toHaveBeenLastCalledWith({
    key: "warning:Retry needed", type: "warning", content: "Retry needed",
    duration: 1.75, className: "ff-feedback-notice",
  });
});

test("requires a cancel-focused application modal for destructive confirmation", async () => {
  const pending = feedback.confirm({ title: "Remove archive", message: "This cannot be undone", dangerous: true });
  await tick();
  expect(ports.dialog).toHaveBeenCalledTimes(1);
  expect(ports.dialog.mock.calls[0][0]).toMatchObject({
    title: "Remove archive", content: "This cannot be undone", maskClosable: false,
    autoFocusButton: "cancel", okButtonProps: { danger: true },
    rootClassName: "ff-feedback-modal ff-feedback-modal--danger",
  });
  ports.dialog.mock.calls[0][0].onCancel();
  await expect(pending).resolves.toBe(false);
});

test.each([false, true])("preserves FIFO even when a third request arrives after settlement: %s", async (late) => {
  const alert = feedback.alert({ tone: "info", title: "Read me", message: "First queued item" });
  const confirm = feedback.confirm({ title: "Continue review", message: "Second queued item" });
  await tick();
  expect(ports.dialog).toHaveBeenCalledTimes(1);
  expect(ports.dialog.mock.calls[0][0].title).toBe("Read me");
  ports.dialog.mock.calls[0][0].onOk();
  await expect(alert).resolves.toBeUndefined();
  const third = late ? feedback.confirm({ title: "Finish review", message: "Last queued item" }) : null;
  await tick();
  expect(ports.dialog).toHaveBeenCalledTimes(2);
  expect(ports.dialog.mock.calls[1][0].title).toBe("Continue review");
  if (late) {
    ports.dialog.mock.calls[1][0].onOk();
    await expect(confirm).resolves.toBe(true);
    await tick();
    expect(ports.dialog).toHaveBeenCalledTimes(3);
    expect(ports.dialog.mock.calls[2][0].title).toBe("Finish review");
    ports.dialog.mock.calls[2][0].onCancel();
    await expect(third).resolves.toBe(false);
  } else {
    ports.dialog.mock.calls[1][0].onCancel();
    await expect(confirm).resolves.toBe(false);
  }
});
