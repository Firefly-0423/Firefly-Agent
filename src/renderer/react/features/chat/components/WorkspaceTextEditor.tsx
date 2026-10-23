import { useCallback, useEffect, useSyncExternalStore } from "react";
import { preserveTextLineEndings } from "./workspace-editor-line-endings";
import { useTranslation } from "../../../i18n";
import type { WorkspaceFileErrorCode, WorkspaceReadResult, WorkspaceSaveResult } from "../../../../../shared/workspace-files-types";

type Snapshot = Extract<WorkspaceReadResult, { ok: true }>;
interface Draft {
  text: string; original: string; editVersion: string; size: number;
  saving: boolean; error?: WorkspaceFileErrorCode;
  discardRequested?: boolean; afterDiscard?: () => void;
}
interface EditorState { draft?: Draft; saved?: Extract<WorkspaceSaveResult, { ok: true }> }
// Memory only: switching conversations never silently discards an unsaved buffer.
const states = new Map<string, EditorState>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const dirty = (draft?: Draft) => Boolean(draft && (draft.saving || draft.text !== draft.original));
const protectUnload = (event: BeforeUnloadEvent) => { if ([...states.values()].some(state => dirty(state.draft))) { event.preventDefault(); event.returnValue = ""; } };
let guardingUnload = false;
function update(key: string, state?: EditorState): void {
  if (state) states.set(key, state); else states.delete(key);
  const needsGuard = [...states.values()].some(state => dirty(state.draft));
  if (needsGuard !== guardingUnload) {
    if (needsGuard) window.addEventListener("beforeunload", protectUnload); else window.removeEventListener("beforeunload", protectUnload);
    guardingUnload = needsGuard;
  }
  for (const listener of listeners) listener();
}
export const workspaceEditorKey = (sessionId: string, workspaceRoot: string | undefined, relPath: string) => JSON.stringify([sessionId, workspaceRoot, relPath]);
export const getWorkspaceEditorState = (key: string) => states.get(key);
export function useWorkspaceEditorState(key: string): EditorState | undefined {
  return useSyncExternalStore(subscribe, useCallback(() => states.get(key), [key]), () => undefined);
}
export function consumeWorkspaceEditorSave(key: string): void { if (states.get(key)?.saved) update(key); }
/** Return false to focus the file and show its in-place discard decision. */
export function requestWorkspaceEditorClose(key: string, onClose: () => void): boolean {
  const draft = states.get(key)?.draft;
  if (draft?.saving) return false;
  if (dirty(draft)) { update(key, { draft: { ...draft!, discardRequested: true, afterDiscard: onClose } }); return false; }
  update(key); return true;
}

export function WorkspaceTextEditor({ editorKey, sessionId, relPath, snapshot, errorText }: {
  editorKey: string; sessionId: string; relPath: string; snapshot?: Snapshot;
  errorText(code: WorkspaceFileErrorCode): string;
}) {
  const { t } = useTranslation();
  const state = useWorkspaceEditorState(editorKey);
  const draft = state?.draft;
  useEffect(() => () => {
    const current = states.get(editorKey)?.draft;
    if (current?.discardRequested) update(editorKey, { draft: { ...current, discardRequested: false, afterDiscard: undefined } });
  }, [editorKey]);
  const save = async () => {
    const current = states.get(editorKey)?.draft;
    if (!current || current.saving || !dirty(current)) return;
    update(editorKey, { draft: { ...current, saving: true, error: undefined } });
    let result: WorkspaceSaveResult;
    try {
      result = await window.workspaceFiles!.save(sessionId, relPath, current.text, current.editVersion);
    } catch { result = { ok: false, code: "WRITE_FAILED" }; }
    if (result.ok) update(editorKey, { saved: result });
    else update(editorKey, { draft: { ...current, saving: false, error: result.code } });
  };
  if (!draft) {
    if (!snapshot) return null;
    return <div className="ff-file-editor__toolbar">
      {snapshot.editVersion && window.workspaceFiles?.save
        ? <button type="button" className="ff-file-refresh" aria-label={t("fileTree.edit")} onClick={() => update(editorKey, { draft: { text: snapshot.content, original: snapshot.content, editVersion: snapshot.editVersion!, size: snapshot.size, saving: false } })}>{t("fileTree.edit")}</button>
        : <span role="status">{errorText(snapshot.readOnlyReason ?? "READ_ONLY")}</span>}
    </div>;
  }
  return <div className="ff-file-editor">
    <div className="ff-file-editor__toolbar">
      <button type="button" className="ff-file-refresh" aria-label={t("fileTree.save")} disabled={draft.saving || !dirty(draft)} onClick={() => void save()}>{t(draft.saving ? "fileTree.saving" : "fileTree.save")}</button>
      <button type="button" className="ff-file-refresh" aria-label={t("fileTree.cancelEdit")} disabled={draft.saving} onClick={() => {
        if (dirty(draft)) update(editorKey, { draft: { ...draft, discardRequested: true, afterDiscard: undefined } });
        else update(editorKey);
      }}>{t("fileTree.cancelEdit")}</button>
      {dirty(draft) && <span className="ff-file-editor__dirty" role="status">{t("fileTree.unsaved")}</span>}
    </div>
    <p className="ff-file-editor__hint">{t("fileTree.saveConfirmation")}</p>
    {draft.error && <p className="ff-file-editor__error" role="alert">{errorText(draft.error)}</p>}
    {draft.discardRequested && <div className="ff-file-editor__decision" role="alert">
      <span>{t("fileTree.discardPrompt")}</span>
      <button type="button" className="ff-file-refresh" aria-label={t("fileTree.keepEditing")} onClick={() => update(editorKey, { draft: { ...draft, discardRequested: false, afterDiscard: undefined } })}>{t("fileTree.keepEditing")}</button>
      <button type="button" className="ff-file-refresh" aria-label={t("fileTree.discard")} onClick={() => { update(editorKey); draft.afterDiscard?.(); }}>{t("fileTree.discard")}</button>
    </div>}
    <textarea className="ff-file-editor__input" aria-label={t("fileTree.editorLabel", { path: relPath })} value={draft.text} spellCheck={false} disabled={draft.saving}
      onInput={event => update(editorKey, { draft: { ...draft, text: preserveTextLineEndings(draft.text, event.currentTarget.value), error: undefined } })}
      onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }} />
  </div>;
}
