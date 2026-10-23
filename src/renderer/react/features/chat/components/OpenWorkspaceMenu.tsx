import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { OpenInAppEntry } from "../../../../../shared/open-in-app-types";
import "./OpenWorkspaceMenu.css";

const BUSY_DRESS_DELAY_MS = 250;
const ERROR_DECAY_MS = 2000;
const EXPLORER_FALLBACK: OpenInAppEntry[] = [{ id: "explorer", name: "资源管理器" }];
type OpenWorkspaceMenuProps = { sessionId: string };

function AppIcon({ app: entry, size: edge }: { app: OpenInAppEntry | undefined; size: number }) {
  return entry?.icon
    ? <img src={entry.icon} width={edge} height={edge} className="ff-open-workspace__icon" alt="" aria-hidden="true" draggable={false} />
    : <svg width={edge} height={edge} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      className="ff-open-workspace__icon" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /></svg>;
}

export function OpenWorkspaceMenu({ sessionId: session }: OpenWorkspaceMenuProps) {
  const { t: translate } = useTranslation();
  const [expanded, expand] = useState(false);
  const [available, updateAvailable] = useState<OpenInAppEntry[] | null>(null);
  const [favorite, updateFavorite] = useState("explorer");
  const [appearance, updateAppearance] = useState<"idle" | "busy" | "error">("idle");
  const launching = useRef(false);
  const busyDelay = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorDelay = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    window.openInApp?.listApps(session).then((reply) => {
      if (disposed) return;
      if (!reply.ok) { updateAvailable(EXPLORER_FALLBACK); return; }
      updateAvailable(reply.apps);
      updateFavorite(reply.preferred);
    }).catch(() => { if (!disposed) updateAvailable(EXPLORER_FALLBACK); });
    return () => { disposed = true; };
  }, [session]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (pointer: PointerEvent) => {
      if (container.current && !container.current.contains(pointer.target as Node)) expand(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  useEffect(() => () => {
    clearTimeout(busyDelay.current);
    clearTimeout(errorDelay.current);
  }, []);

  const lookup = new Map((available ?? []).map((entry) => [entry.id, entry]));
  const selected = lookup.get(favorite) ?? available?.[0] ?? EXPLORER_FALLBACK[0];
  const nameOf = (entry: OpenInAppEntry) => entry.id === "explorer" ? translate("openWorkspace.appExplorer") : entry.name;
  const selectedName = selected ? nameOf(selected) : translate("openWorkspace.appExplorer");
  const tooltip = appearance === "error" ? translate("openWorkspace.openError") : translate("openWorkspace.tooltip", { app: selectedName });

  const launch = (target: string): void => {
    if (launching.current) return;
    launching.current = true;
    clearTimeout(errorDelay.current);
    clearTimeout(busyDelay.current);
    busyDelay.current = setTimeout(() => updateAppearance("busy"), BUSY_DRESS_DELAY_MS);
    const clearBusy = () => {
      launching.current = false;
      clearTimeout(busyDelay.current);
    };
    const indicateFailure = () => {
      updateAppearance("error");
      errorDelay.current = setTimeout(() => updateAppearance("idle"), ERROR_DECAY_MS);
    };
    window.openInApp?.open(session, target).then((reply) => {
      clearBusy();
      if (!reply.ok) { indicateFailure(); return; }
      updateAppearance("idle");
      updateFavorite(target);
    }, () => { clearBusy(); indicateFailure(); });
  };

  const menu = expanded && <div className="ff-open-workspace__menu" role="menu">
    {available === null && <div className="ff-open-workspace__hint">{translate("openWorkspace.detecting")}</div>}
    {available?.map((entry) => <button type="button" role="menuitem" key={entry.id}
      className={`ff-open-workspace__item ${entry.id === favorite ? "is-selected" : ""}`}
      onClick={() => { expand(false); launch(entry.id); }}>
      <AppIcon app={entry} size={18} />
      <span className="ff-open-workspace__item-name">{nameOf(entry)}</span>
      {entry.id === favorite && <svg className="ff-open-workspace__check" width="12" height="12" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6L9 17l-5-5" />
      </svg>}
    </button>)}
  </div>;
  return <div className="ff-open-workspace" ref={container} data-phase={appearance}>
    <button type="button" className="ff-open-workspace__main" onClick={() => launch(selected.id)}
      disabled={appearance === "busy"} title={tooltip} aria-label={tooltip}>
      <AppIcon app={selected} size={16} />
    </button>
    <button type="button" className={`ff-open-workspace__chevron ${expanded ? "is-open" : ""}`}
      onClick={() => expand((previous) => !previous)} aria-expanded={expanded} aria-haspopup="menu"
      title={translate("openWorkspace.menuToggle")} aria-label={translate("openWorkspace.menuToggle")}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {menu}
  </div>;
}
