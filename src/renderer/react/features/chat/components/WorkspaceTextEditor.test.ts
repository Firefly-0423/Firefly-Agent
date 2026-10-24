// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./ChatMessageList", () => ({ MarkdownContent: ({ content }: { content: string }) => createElement("article", null, content) }));
vi.mock("shiki", () => ({ createHighlighter: async () => ({ codeToTokens: (text: string) => ({ tokens: text.split("\n").map(content => [{ content, offset: 0 }]) }) }) }));
import { FilePreviewContent } from "./FileTreePanel";
import { requestWorkspaceEditorClose, workspaceEditorKey } from "./WorkspaceTextEditor";
let host: HTMLDivElement; let root: Root; let session = 0;
const read = vi.fn(); const save = vi.fn();
const snapshot = (content: string, editVersion = "a".repeat(64)) => ({ ok: true, content, size: content.length, editVersion });
const key = () => workspaceEditorKey(`editor-${session}`, "/synthetic", "notes.md");
beforeEach(() => {
 session++; vi.stubGlobal("React", React); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 read.mockReset().mockResolvedValue(snapshot("# original")); save.mockReset().mockResolvedValue(snapshot("# saved", "b".repeat(64)));
 window.workspaceFiles = { list: vi.fn(), read, save }; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.workspaceFiles; vi.unstubAllGlobals(); });
async function render(extra: Record<string, unknown> = {}) { await act(async () => root.render(createElement(FilePreviewContent, { sessionId: `editor-${session}`, workspaceRoot: "/synthetic", relPath: "notes.md", ...extra }))); }
function button(key: string) { const node = host.querySelector<HTMLButtonElement>(`button[aria-label="fileTree.${key}"]`); expect(node, key).not.toBeNull(); return node!; }
async function click(key: string) { await act(async () => button(key).click()); }
async function edit(text = "# draft") { await click("edit"); await type(text); }
async function type(text: string) { const textarea = host.querySelector("textarea")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text); textarea.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("edits explicitly, shows native confirmation guidance, saves and updates preview", async () => {
 await render(); expect(host.querySelector("textarea")).toBeNull(); await edit("# saved"); expect(host.textContent).toContain("fileTree.saveConfirmation"); expect(host.textContent).toContain("fileTree.unsaved"); await click("save");
 expect(save).toHaveBeenCalledWith(`editor-${session}`, "notes.md", "# saved", "a".repeat(64)); expect(host.querySelector("textarea")).toBeNull(); expect(host.querySelector("article")?.textContent).toBe("# saved");
});
it("retains drafts and shows conflict/native-denial errors without replacing text", async () => {
 await render(); await edit(); save.mockResolvedValueOnce({ ok: false, code: "CONFLICT" }); await click("save"); expect(host.querySelector("textarea")?.value).toBe("# draft"); expect(host.textContent).toContain("fileTree.errConflict");
 save.mockResolvedValueOnce({ ok: false, code: "CANCELLED" }); await click("save"); expect(host.querySelector("textarea")?.value).toBe("# draft"); expect(host.textContent).toContain("fileTree.errCancelled");
 save.mockResolvedValueOnce({ ok: false, code: "WRITE_BUSY" }); await click("save"); expect(host.textContent).toContain("fileTree.errWriteBusy"); expect(host.querySelector("textarea")?.value).toBe("# draft"); expect(button("cancelEdit").disabled).toBe(false);
});
it("requires discard confirmation and can keep editing", async () => {
 await render(); await edit(); await click("cancelEdit"); expect(host.textContent).toContain("fileTree.discardPrompt"); await click("keepEditing"); expect(host.querySelector("textarea")?.value).toBe("# draft"); await click("cancelEdit"); await click("discard"); expect(host.querySelector("textarea")).toBeNull(); expect(host.querySelector("article")?.textContent).toBe("# original"); expect(save).not.toHaveBeenCalled();
});
it("does not clobber the draft on external refresh and restores it after session switch", async () => {
 await render(); await edit(); await render({ refreshRevision: 1 }); expect(host.querySelector("textarea")?.value).toBe("# draft"); expect(button("refreshPreview").disabled).toBe(true);
 await render({ sessionId: "other-session" }); expect(host.querySelector("textarea")).toBeNull(); await render(); expect(host.querySelector("textarea")?.value).toBe("# draft");
});
it("protects tab close with an explicit discard prompt", async () => {
 await render(); await edit(); const closed = vi.fn(); let accepted = true; await act(async () => { accepted = requestWorkspaceEditorClose(key(), closed); }); expect(accepted).toBe(false); expect(closed).not.toHaveBeenCalled(); await click("keepEditing"); expect(closed).not.toHaveBeenCalled();
 await act(async () => { requestWorkspaceEditorClose(key(), closed); }); await click("discard"); expect(closed).toHaveBeenCalledOnce();
});
it("locks save/cancel and duplicate clicks while Main approval is pending", async () => {
 let resolve!: (value: unknown) => void; save.mockReturnValue(new Promise(done => { resolve = done; })); await render(); await edit(); await click("save"); expect(button("save").disabled).toBe(true); expect(button("cancelEdit").disabled).toBe(true); expect(host.querySelector("textarea")?.disabled).toBe(true); await click("save"); expect(save).toHaveBeenCalledOnce();
 await act(async () => { resolve({ ok: false, code: "WRITE_FAILED" }); }); expect(host.querySelector("textarea")?.value).toBe("# draft"); expect(button("save").disabled).toBe(false);
});
it("does not apply an old save result to a newer session", async () => {
 let resolve!: (value: unknown) => void; save.mockReturnValue(new Promise(done => { resolve = done; })); await render(); await edit(); await click("save"); read.mockResolvedValue(snapshot("# another")); await render({ sessionId: "new-session" }); await act(async () => resolve(snapshot("# old saved"))); expect(host.querySelector("article")?.textContent).toBe("# another");
});
it("explains preview-only files instead of offering edit", async () => {
 read.mockResolvedValue({ ok: true, content: "preview", size: 7, readOnlyReason: "LINK_READ_ONLY" }); await render(); expect(host.querySelector('button[aria-label="fileTree.edit"]')).toBeNull(); expect(host.textContent).toContain("fileTree.errLinkReadOnly");
});
it("retains CRLF line endings when a textarea supplies normalized newlines", async () => {
 read.mockResolvedValue(snapshot("first\r\nsecond\r\n")); await render(); await edit("first\nupdated\n"); await click("save");
 expect(save).toHaveBeenCalledWith(`editor-${session}`, "notes.md", "first\r\nupdated\r\n", "a".repeat(64));
});
it("preserves mixed line endings outside the edited line", async () => {
 read.mockResolvedValue(snapshot("first\r\nsecond\nthird\r\n")); await render(); await edit("first\nupdated\nthird\n"); await click("save");
 expect(save).toHaveBeenCalledWith(`editor-${session}`, "notes.md", "first\r\nupdated\nthird\r\n", "a".repeat(64));
});
