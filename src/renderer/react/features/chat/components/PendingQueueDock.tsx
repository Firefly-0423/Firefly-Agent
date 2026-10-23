import { CheckOutlined, CloseOutlined, DeleteOutlined, DownOutlined, EditOutlined, EnterOutlined, PaperClipOutlined, UnorderedListOutlined, UpOutlined } from "@ant-design/icons";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "../../../i18n";

export interface PendingQueueDockItem {
  attachmentCount?: number;
  content: string;
  id: string;
}
type PendingQueueDockProps = {
  onRemove?: (id: string) => Promise<void> | void;
  onAdjust?: (id: string) => Promise<boolean>;
  onEdit?: (id: string, content: string) => Promise<boolean>;
  adjustmentAvailable: boolean;
  items: PendingQueueDockItem[];
};

function actionButton(icon: ReactNode, label: string, tooltip: string, disabled: boolean, activate: () => void) {
  return <button type="button" aria-label={label} title={tooltip} disabled={disabled} onClick={activate}>{icon}</button>;
}

export function PendingQueueDock({ items: queue, adjustmentAvailable: adjustable, onEdit: edit, onAdjust: revise, onRemove: remove }: PendingQueueDockProps) {
  const { t: translate } = useTranslation();
  const [unfolded, unfold] = useState(false);
  const [draft, updateDraft] = useState<{ id: string; content: string } | null>(null);
  const [pending, markPending] = useState<string | null>(null);
  useEffect(() => {
    if (queue.length <= 1) unfold(false);
    if (draft && !queue.some((entry) => entry.id === draft.id)) updateDraft(null);
  }, [draft, queue]);
  if (queue.length === 0) return null;
  const visible = queue.length === 1 || unfolded || draft !== null;

  const save = async () => {
    if (!draft || !draft.content.trim() || !edit) return;
    markPending(draft.id);
    try {
      if (await edit(draft.id, draft.content)) updateDraft(null);
    } finally { markPending(null); }
  };
  const adjust = async (target: string) => {
    if (!revise || !adjustable) return;
    markPending(target);
    try { await revise(target); } finally { markPending(null); }
  };

  const rows = visible && <div className="ff-queue-dock__list">{queue.map((entry) => {
    const editing = draft?.id === entry.id;
    const locked = pending !== null;
    const begin = () => updateDraft({ id: entry.id, content: entry.content });
    return <div className="ff-queue-dock__row" key={entry.id}>
      {queue.length === 1 && <UnorderedListOutlined className="ff-queue-dock__lead" aria-hidden="true" />}
      {editing ? <input className="ff-queue-dock__editor" value={draft.content} autoFocus disabled={locked}
        aria-label={translate("composer.queueEditInput")}
        onChange={(event) => updateDraft({ id: entry.id, content: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void save(); }
          else if (event.key === "Escape") updateDraft(null);
        }} /> : <button type="button" className="ff-queue-dock__content" title={entry.content} disabled={locked} onClick={begin}>
        <span>{entry.content}</span>
        {Boolean(entry.attachmentCount) && <small><PaperClipOutlined aria-hidden="true" /> {entry.attachmentCount}</small>}
      </button>}
      <div className="ff-queue-dock__actions">
        {editing ? <>
          {actionButton(<CheckOutlined />, translate("composer.queueSave"), translate("composer.queueSave"), locked || !draft.content.trim(), () => void save())}
          {actionButton(<CloseOutlined />, translate("composer.queueCancelEdit"), translate("composer.queueCancelEdit"), locked, () => updateDraft(null))}
        </> : <>
          {actionButton(<EditOutlined />, translate("composer.queueEdit"), translate("composer.queueEdit"), locked, begin)}
          {actionButton(<EnterOutlined />, translate("composer.queueAdjust"), adjustable ? translate("composer.queueAdjust") : translate("composer.queueAdjustUnavailable"), locked || !adjustable, () => void adjust(entry.id))}
          {actionButton(<DeleteOutlined />, translate("composer.removeQueuedMessage"), translate("composer.removeQueuedMessage"), locked, () => void remove?.(entry.id))}
        </>}
      </div>
    </div>;
  })}</div>;
  return <section className="ff-queue-dock" aria-label={translate("composer.queueLabel")}>
    {queue.length > 1 && <button type="button" className="ff-queue-dock__header" aria-expanded={visible} onClick={() => unfold((previous) => !previous)}>
      <UnorderedListOutlined aria-hidden="true" /><span>{translate("composer.queueCount", { count: queue.length })}</span>
      {visible ? <UpOutlined aria-hidden="true" /> : <DownOutlined aria-hidden="true" />}
    </button>}
    {rows}
  </section>;
}
