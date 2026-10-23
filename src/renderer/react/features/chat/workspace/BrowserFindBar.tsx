import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "../../../i18n";

const TYPING_PAUSE_MS = 150;

export interface BrowserFindBarProps {
  /** Main's current search, or null before the first one. */
  find: { query: string; active: number; matches: number } | null;
  /** Text typed so far; empty means the search should be cleared. Called after a short pause in typing. */
  onQuery(text: string): void;
  /** Steps to the next or previous match of `text` (the bar's own text, so a pending edit is searched first). */
  onStep(forward: boolean, text: string): void;
  onClose(): void;
}

/** The find-in-page row under the toolbar. Enter steps forward, Shift+Enter backward, Escape closes. */
export function BrowserFindBar({ find, onQuery, onStep, onClose }: BrowserFindBarProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(find?.query ?? "");
  const input = useRef<HTMLInputElement>(null), last = useRef(find?.query ?? "");
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    if (text.trim() === last.current.trim()) return;
    const timer = window.setTimeout(() => { last.current = text; onQuery(text.trim()); }, TYPING_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [text, onQuery]);
  const searched = find !== null && find.query !== "";
  const label = !searched ? "" : find.matches > 0 ? t("browserWorkspace.tools.findCount", { active: find.active, total: find.matches }) : t("browserWorkspace.tools.findNone");
  return <div className="ff-browser-find" role="search" data-browser-find-bar>
    <input ref={input} type="text" value={text} spellCheck={false} autoComplete="off" maxLength={200}
      aria-label={t("browserWorkspace.tools.find")} placeholder={t("browserWorkspace.tools.findPlaceholder")}
      onChange={event => setText(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.key === "Enter") { event.preventDefault(); if (text.trim()) { last.current = text; onStep(!event.shiftKey, text.trim()); } }
      }} />
    <span className="ff-browser-find__count" role="status" aria-live="polite">{label}</span>
    <button type="button" aria-label={t("browserWorkspace.tools.findPrev")} title={t("browserWorkspace.tools.findPrev")} disabled={!searched || find.matches === 0} onClick={() => onStep(false, find?.query ?? "")}>
      <ChevronUp size={15} aria-hidden="true" />
    </button>
    <button type="button" aria-label={t("browserWorkspace.tools.findNext")} title={t("browserWorkspace.tools.findNext")} disabled={!searched || find.matches === 0} onClick={() => onStep(true, find?.query ?? "")}>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    <button type="button" aria-label={t("browserWorkspace.tools.findClose")} title={t("browserWorkspace.tools.findClose")} onClick={onClose}>
      <X size={15} aria-hidden="true" />
    </button>
  </div>;
}
