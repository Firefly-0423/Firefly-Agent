// @vitest-environment jsdom
import { act, createElement as element } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useSessionMessages } from "./useSessionMessages";
import type { SessionMessagesApi } from "./useSessionMessages";
import type { ChatMessageItem } from "../components/ChatMessageList";

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).reverse().forEach(close => close()); vi.unstubAllGlobals(); });
function mailbox(selected?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let api: SessionMessagesApi;
  const selection = vi.fn(() => selected);
  const container = document.body.appendChild(document.createElement("article"));
  const renderer = createRoot(container);
  function Screen() { api = useSessionMessages(selection); return null; }
  act(() => renderer.render(element(Screen)));
  dispose.push(() => { act(() => renderer.unmount()); container.remove(); });
  return { read: () => api!, selection, change: (fn: (value: SessionMessagesApi) => void) => act(() => fn(api!)) };
}
const line = (id: string, content = id): ChatMessageItem => ({ role: "user", id, content });

test("independent mailboxes append in order and replacement retains their neighbours", () => {
  const box = mailbox();
  box.change(a => { a.appendMessages("alpha", [line("one"), line("two")]); a.appendMessages("beta", [line("elsewhere")]); a.appendMessages("alpha", [line("three")]); });
  expect(box.read().messagesBySession).toEqual({ alpha: [line("one"), line("two"), line("three")], beta: [line("elsewhere")] });
  box.change(a => a.replaceSessionMessages("alpha", [line("replacement")]));
  expect(box.read().messagesBySession).toEqual({ alpha: [line("replacement")], beta: [line("elsewhere")] });
});
test("a concrete session patches only its addressed row despite duplicate ids elsewhere", () => {
  const box = mailbox();
  box.change(a => { a.appendMessages("alpha", [line("same", "original"), line("target")]); a.appendMessages("beta", [line("same", "mirror")]); });
  box.change(a => a.patchMessage("alpha", "target", { content: "revised" }));
  expect(box.read().messagesBySession).toEqual({ alpha: [line("same", "original"), line("target", "revised")], beta: [line("same", "mirror")] });
});
test("mode addressing locates the owning mailbox before consulting active selection", () => {
  const box = mailbox("alpha");
  box.change(a => a.appendMessages("beta", [line("remote")]));
  box.change(a => a.patchMessage("chat", "remote", { content: "located" }));
  expect(box.read().messagesBySession.beta).toEqual([line("remote", "located")]);
  expect(box.selection).not.toHaveBeenCalled();
});
test("an unowned mode row falls back without altering unrelated contents", () => {
  const box = mailbox("alpha");
  box.change(a => a.appendMessages("alpha", [line("existing")]));
  box.change(a => a.patchMessage("chat", "absent", { content: "ignored" }));
  expect(box.selection).toHaveBeenCalledWith("chat");
  expect(box.read().messagesBySession).toEqual({ alpha: [line("existing")] });
});
test("missing mode selection does nothing while an unknown concrete session receives an empty list", () => {
  const box = mailbox();
  box.change(a => { a.appendMessages("alpha", [line("existing")]); a.patchMessage("chat", "absent", { content: "ignored" }); a.patchMessage("unknown-session", "existing", { content: "ignored" }); });
  expect(box.read().messagesBySession).toEqual({ alpha: [line("existing")], "unknown-session": [] });
});
test("hydration protects live rows but loads idle and first-view sessions", () => {
  const box = mailbox();
  box.change(a => a.appendMessages("alpha", [line("reply", "live")]));
  box.change(a => a.hydrateMessages("alpha", [line("reply", "disk")], true));
  expect(box.read().messagesBySession.alpha).toEqual([line("reply", "live")]);
  box.change(a => { a.hydrateMessages("alpha", [line("reply", "disk")], false); a.hydrateMessages("beta", [line("initial")], true); });
  expect(box.read().messagesBySession).toEqual({ alpha: [line("reply", "disk")], beta: [line("initial")] });
});
test("attachment transforms start with an empty list then receive previous attachments", () => {
  const box = mailbox();
  box.change(a => a.appendMessages("alpha", [line("question"), { role: "assistant", id: "answer", content: "" }]));
  const first = { kind: "image" as const, name: "capture.png", status: "processing" as const };
  const second = { kind: "document" as const, name: "manual.txt" };
  box.change(a => a.patchMessageAttachments("alpha", "answer", current => [...current, first]));
  expect(box.read().messagesBySession.alpha[1].attachments).toEqual([first]);
  expect(box.read().messagesBySession.alpha[0].attachments).toBeUndefined();
  box.change(a => a.patchMessageAttachments("alpha", "answer", current => [...current, second]));
  expect(box.read().messagesBySession.alpha[1].attachments).toEqual([first, second]);
});
