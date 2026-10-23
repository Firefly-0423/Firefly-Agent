import { Input, Modal } from "antd";
import { MessageSquareText, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import "./SidebarSearchDialog.css";

interface SidebarSearchDialogProps {
  open: boolean;
  sessions: ChatSessionMeta[];
  activeSessionId?: string;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
}

const RECENT_LIMIT = 6;
const RESULT_LIMIT = 20;

/** Quick switcher over the sessions of the current mode: title, project name and project path are searched. */
export function SidebarSearchDialog({ open, sessions, activeSessionId, onClose, onSelect }: SidebarSearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (open) { setQuery(""); setHighlight(0); }
  }, [open]);

  const results = useMemo(() => {
    const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return ordered.slice(0, RECENT_LIMIT);
    return ordered.filter(session =>
      `${session.title} ${session.workspaceDisplayName ?? ""} ${session.workspaceRoot ?? ""}`.toLocaleLowerCase().includes(needle),
    ).slice(0, RESULT_LIMIT);
  }, [sessions, query]);

  useEffect(() => { setHighlight(0); }, [query]);

  function choose(sessionId: string) {
    onClose();
    onSelect(sessionId);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlight(index => (index + 1) % results.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight(index => (index + results.length - 1) % results.length); }
    else if (event.key === "Enter") { event.preventDefault(); choose(results[Math.min(highlight, results.length - 1)].id); }
  }

  const heading = searching ? t("sidebar.searchResults") : t("sidebar.recentSessions");
  return (
    <Modal className="ff-sidebar-search-modal" open={open} centered width={520} title={null} footer={null}
      closable={false} onCancel={onClose} destroyOnHidden>
      <div className="ff-sidebar-search" onKeyDown={onKeyDown}>
        <Input autoFocus allowClear prefix={<Search size={16} aria-hidden="true" />} placeholder={t("sidebar.searchSessions")}
          aria-label={t("sidebar.searchSessions")} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="ff-sidebar-search__heading">{heading}</div>
        {results.length === 0
          ? <div className="ff-sidebar-search__empty">{t("sidebar.noSearchResults")}</div>
          : <div className="ff-sidebar-search__list" role="listbox" aria-label={heading}>
            {results.map((session, index) => (
              <button key={session.id} type="button" role="option" aria-selected={index === highlight}
                className={`ff-sidebar-search__item${index === highlight ? " is-highlighted" : ""}${session.id === activeSessionId ? " is-current" : ""}`}
                onMouseEnter={() => setHighlight(index)} onClick={() => choose(session.id)}>
                <MessageSquareText size={15} aria-hidden="true" />
                <span className="ff-sidebar-search__copy">
                  <span className="ff-sidebar-search__title">{session.title || t("sidebar.defaultSessionTitle")}</span>
                  <span className="ff-sidebar-search__project">{session.workspaceDisplayName || session.workspaceRoot || t("sidebar.unboundProject")}</span>
                </span>
              </button>
            ))}
          </div>}
      </div>
    </Modal>
  );
}
