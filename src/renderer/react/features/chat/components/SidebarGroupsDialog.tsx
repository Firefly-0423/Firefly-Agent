import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Modal } from "antd";
import { Eye, EyeOff, GripVertical, Pencil, X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import "./SidebarGroupsDialog.css";

/** A group the sidebar shows right now, in its current order. Sections can be renamed and deleted; project groups toggle visibility. */
export interface SidebarGroupRow { groupId: string; label: string; sectionId?: string; projectId?: string }
/** A project that has no group in the list (hidden, or merged into one list); it can only be shown or hidden. */
export interface SidebarProjectRow { id: string; label: string; title: string; visible: boolean }

interface SidebarGroupsDialogProps {
  open: boolean;
  pending: boolean;
  rows: SidebarGroupRow[];
  projectRows: SidebarProjectRow[];
  onClose(): void;
  onAdd(name: string): Promise<boolean>;
  onRename(sectionId: string, name: string): void;
  onDelete(sectionId: string): void;
  /** Receives the visible group ids in their new order; the caller keeps hidden groups in place. */
  onReorder(groupIds: string[]): void;
  onToggleProject(projectId: string, visible: boolean): void;
}

/** Pointer travel below this many pixels is a click, not a drag. */
const DRAG_DEAD_ZONE = 4;

type Drag = { id: string; dropAt: number | null } | null;

/** Compact manager for sidebar groups: add, rename, delete sections, reorder every group, show or hide projects. */
export function SidebarGroupsDialog({ open, pending, rows, projectRows, onClose, onAdd, onRename, onDelete, onReorder, onToggleProject }: SidebarGroupsDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const focusRow = useRef<string | null>(null);
  const endDrag = useRef<(() => void) | null>(null);
  // Window listeners outlive the render that created them, so they read the latest props from here.
  const latest = useRef({ rows, pending, onReorder });
  latest.current = { rows, pending, onReorder };

  useEffect(() => { if (!open) { setName(""); setEditing(null); setConfirming(null); } }, [open]);
  useEffect(() => () => endDrag.current?.(), []);
  // After a keyboard or pointer move the order changes; put focus back on the row that moved.
  const orderKey = rows.map(row => row.groupId).join("\n");
  useEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    focusRow.current = null;
    rowEls.current.get(id)?.focus();
  }, [orderKey]);

  const moveRow = (from: number, to: number) => {
    const ids = latest.current.rows.map(row => row.groupId);
    if (latest.current.pending || to === from || to < 0 || to >= ids.length) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    focusRow.current = moved;
    latest.current.onReorder(ids);
  };

  const startDrag = (event: ReactPointerEvent<HTMLSpanElement>, id: string) => {
    if (event.button !== 0 || latest.current.pending) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let dropAt: number | null = null;
    const ids = () => latest.current.rows.map(row => row.groupId);
    // The first row whose midpoint sits below the pointer; the dragged row is skipped so it never blocks its own slot.
    const slotAt = (clientY: number) => {
      const list = ids();
      for (let index = 0; index < list.length; index++) {
        const el = list[index] === id ? undefined : rowEls.current.get(list[index]);
        if (!el) continue;
        const box = el.getBoundingClientRect();
        if (clientY < box.top + box.height / 2) return index;
      }
      return list.length;
    };
    const onMove = (move: PointerEvent) => {
      if (!active) {
        if (Math.abs(move.clientX - startX) <= DRAG_DEAD_ZONE && Math.abs(move.clientY - startY) <= DRAG_DEAD_ZONE) return;
        active = true;
      }
      const from = ids().indexOf(id);
      const slot = slotAt(move.clientY);
      // Dropping right where the row already is changes nothing, so no indicator is shown.
      dropAt = slot === from || slot === from + 1 ? null : slot;
      const indicator = dropAt;
      setDrag(current => current?.id === id && current.dropAt === indicator ? current : { id, dropAt: indicator });
    };
    const release = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", release);
      endDrag.current = null;
      setDrag(null);
    };
    const onUp = () => {
      const commit = active && dropAt !== null ? { from: ids().indexOf(id), to: dropAt } : null;
      release();
      if (commit) moveRow(commit.from, commit.to > commit.from ? commit.to - 1 : commit.to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", release);
    endDrag.current = release;
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.target !== event.currentTarget || !event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    moveRow(index, index + (event.key === "ArrowUp" ? -1 : 1));
  };

  const submitAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    void onAdd(trimmed).then(ok => { if (ok) setName(""); });
  };

  const commitRename = (row: SidebarGroupRow) => {
    const draft = editing?.draft.trim() ?? "";
    setEditing(null);
    rowEls.current.get(row.groupId)?.focus();
    if (draft && draft !== row.label && row.sectionId) onRename(row.sectionId, draft);
  };

  const visibilityButton = (projectId: string, visible: boolean) => {
    const label = t(visible ? "sidebar.hideProject" : "sidebar.showProject");
    return (
      <button type="button" className="ff-sidebar-groups__icon" disabled={pending} aria-label={label} title={label}
        onClick={() => onToggleProject(projectId, !visible)}>
        {visible ? <Eye size={14} strokeWidth={1.8} aria-hidden="true" /> : <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />}
      </button>
    );
  };

  return (
    <Modal className="ff-sidebar-groups-modal" open={open} title={t("sidebar.manageSections")} width={360} centered footer={null}
      destroyOnHidden onCancel={onClose}>
      <div className="ff-sidebar-groups">
        <form className="ff-sidebar-groups__add" onSubmit={submitAdd}>
          <input autoFocus aria-label={t("sidebar.sectionName")} placeholder={t("sidebar.sectionName")} maxLength={120}
            value={name} onChange={event => setName(event.target.value)} />
          <button type="submit" disabled={pending || !name.trim()}>{t("sidebar.addSection")}</button>
        </form>
        <p className="ff-sidebar-groups__hint">{t("sidebar.reorderHint")}</p>
        <ul className="ff-sidebar-groups__list" aria-label={t("sidebar.groupOrder")}>
          {rows.map((row, index) => {
            const id = row.groupId;
            const isSection = row.sectionId !== undefined;
            const isEditing = editing?.id === id;
            const classes = ["ff-sidebar-groups__row",
              drag?.id === id ? "is-dragging" : "",
              drag?.dropAt === index ? "is-drop-before" : "",
              drag?.dropAt === rows.length && index === rows.length - 1 ? "is-drop-after" : ""].filter(Boolean).join(" ");
            return (
              <li key={id} className={classes} tabIndex={0} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                ref={el => { if (el) rowEls.current.set(id, el); else rowEls.current.delete(id); }}
                onKeyDown={event => onRowKeyDown(event, index)}>
                <span className="ff-sidebar-groups__handle" aria-hidden="true" title={t("sidebar.dragToReorder")}
                  onPointerDown={event => startDrag(event, id)}>
                  <GripVertical size={14} strokeWidth={1.8} />
                </span>
                {isEditing ? (
                  <input className="ff-sidebar-groups__input" aria-label={t("sidebar.renameSection")} autoFocus maxLength={120}
                    value={editing.draft}
                    onChange={event => setEditing({ id, draft: event.target.value })}
                    onKeyDown={event => {
                      if (event.key === "Enter") { event.preventDefault(); commitRename(row); }
                      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); rowEls.current.get(id)?.focus(); }
                    }}
                    onBlur={() => setEditing(null)} />
                ) : isSection ? (
                  <button type="button" className="ff-sidebar-groups__name" title={row.label} disabled={pending}
                    onClick={() => setEditing({ id, draft: row.label })}>{row.label}</button>
                ) : (
                  <span className="ff-sidebar-groups__name" title={row.label}>{row.label}</span>
                )}
                {isSection && !isEditing && (
                  <span className="ff-sidebar-groups__actions">
                    <button type="button" className="ff-sidebar-groups__icon" disabled={pending} aria-label={t("sidebar.renameSection")}
                      title={t("sidebar.renameSection")} onClick={() => setEditing({ id, draft: row.label })}>
                      <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <button type="button" className="ff-sidebar-groups__icon" disabled={pending} aria-label={t("sidebar.deleteSection")}
                      title={t("sidebar.deleteSection")} onClick={() => setConfirming(id)}>
                      <X size={14} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </span>
                )}
                {row.projectId !== undefined && <span className="ff-sidebar-groups__actions">{visibilityButton(row.projectId, true)}</span>}
                {isSection && confirming === id && (
                  <div className="ff-sidebar-groups__confirm" role="group" aria-label={t("sidebar.deleteSectionQuestion")}>
                    <span>
                      <strong>{t("sidebar.deleteSectionQuestion")}</strong> {t("sidebar.deleteSectionHint")}
                    </span>
                    <button type="button" className="ff-sidebar-groups__text is-danger" disabled={pending}
                      onClick={() => { setConfirming(null); onDelete(row.sectionId!); }}>{t("sidebar.confirmDelete")}</button>
                    <button type="button" className="ff-sidebar-groups__text" onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {projectRows.length > 0 && (
          <section className="ff-sidebar-groups__projects" aria-label={t("sidebar.projectVisibility")}>
            <div className="ff-sidebar-groups__heading">{t("sidebar.projectVisibility")}</div>
            <ul className="ff-sidebar-groups__list">
              {projectRows.map(project => (
                <li key={project.id} className={`ff-sidebar-groups__row${project.visible ? "" : " is-hidden"}`}>
                  <span className="ff-sidebar-groups__handle is-idle" aria-hidden="true" />
                  <span className="ff-sidebar-groups__name" title={project.title}>{project.label}</span>
                  <span className="ff-sidebar-groups__actions">{visibilityButton(project.id, project.visible)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
