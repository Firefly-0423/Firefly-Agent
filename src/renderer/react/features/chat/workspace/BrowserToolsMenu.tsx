import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Camera, Check, ChevronDown, Clock, Cookie, Download, FolderOpen, Minus, Monitor, Plus, Printer, RotateCcw, Search, Settings, Smartphone, Tablet, Trash2, X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { BrowserDevicePreset, BrowserDownloadDto, BrowserHistoryEntryDto, BrowserZoomOp } from "../../../../../shared/browser-tools";
import { formatBytes } from "./browser-tools-state";

export type BrowserMenuAction = "find" | "print" | "screenshot" | "cookies" | "downloads" | "history" | "clear-data" | "settings";

function arrowNavigation(event: KeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
  if (event.key === "Tab") { onClose(); return; }
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next].focus();
}

function Item({ icon, label, onSelect, disabled, title, trailing, role = "menuitem", checked }: {
  icon?: ReactNode; label: string; onSelect(): void; disabled?: boolean; title?: string; trailing?: ReactNode; role?: "menuitem" | "menuitemradio"; checked?: boolean;
}) {
  return <button type="button" role={role} aria-checked={role === "menuitemradio" ? !!checked : undefined} className="ff-browser-menu__item" disabled={disabled} title={title}
    onClick={onSelect}>
    <span className="ff-browser-menu__icon" aria-hidden="true">{icon}</span>
    <span className="ff-browser-menu__label">{label}</span>
    {trailing}
  </button>;
}

export interface BrowserMoreMenuProps {
  pageLoaded: boolean;
  zoomPercent: number;
  device: BrowserDevicePreset;
  onAction(action: BrowserMenuAction): void;
  onZoom(op: BrowserZoomOp): void;
  onDevice(preset: BrowserDevicePreset): void;
  onClose(): void;
}

/** The "more" menu. Zoom and device choices keep it open; every other entry closes it. */
export function BrowserMoreMenu({ pageLoaded, zoomPercent, device, onAction, onZoom, onDevice, onClose }: BrowserMoreMenuProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [deviceOpen, setDeviceOpen] = useState(device !== "off");
  useEffect(() => { root.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus(); }, []);
  const needsPage = pageLoaded ? undefined : t("browserWorkspace.tools.needsPage");
  const deviceLabel = { off: t("browserWorkspace.tools.deviceOff"), phone: t("browserWorkspace.tools.devicePhone"), tablet: t("browserWorkspace.tools.deviceTablet") } as const;
  return <div ref={root} className="ff-browser-menu" role="menu" aria-label={t("browserWorkspace.tools.more")} onKeyDown={event => arrowNavigation(event, onClose)}>
    <Item icon={<Search size={16} />} label={t("browserWorkspace.tools.find")} disabled={!pageLoaded} title={needsPage} onSelect={() => onAction("find")} />
    <Item icon={<Printer size={16} />} label={t("browserWorkspace.tools.print")} disabled={!pageLoaded} title={needsPage} onSelect={() => onAction("print")} />
    <div className="ff-browser-menu__separator" role="separator" />
    <div className="ff-browser-menu__zoom" role="group" aria-label={t("browserWorkspace.tools.zoom")}>
      <span className="ff-browser-menu__label">{t("browserWorkspace.tools.zoom")}</span>
      <span className="ff-browser-menu__zoom-controls">
        <button type="button" role="menuitem" aria-label={t("browserWorkspace.tools.zoomOut")} title={t("browserWorkspace.tools.zoomOut")} disabled={!pageLoaded || zoomPercent <= 25} onClick={() => onZoom("out")}><Minus size={14} aria-hidden="true" /></button>
        <output className="ff-browser-menu__zoom-value" aria-live="polite">{zoomPercent}%</output>
        <button type="button" role="menuitem" aria-label={t("browserWorkspace.tools.zoomIn")} title={t("browserWorkspace.tools.zoomIn")} disabled={!pageLoaded || zoomPercent >= 500} onClick={() => onZoom("in")}><Plus size={14} aria-hidden="true" /></button>
        <button type="button" role="menuitem" aria-label={t("browserWorkspace.tools.zoomReset")} title={t("browserWorkspace.tools.zoomReset")} disabled={!pageLoaded || zoomPercent === 100} onClick={() => onZoom("reset")}><RotateCcw size={14} aria-hidden="true" /></button>
      </span>
    </div>
    <div className="ff-browser-menu__separator" role="separator" />
    <Item icon={<Smartphone size={16} />} label={t("browserWorkspace.tools.device")} disabled={!pageLoaded} title={needsPage}
      trailing={<ChevronDown size={14} className={`ff-browser-menu__chevron${deviceOpen ? " is-open" : ""}`} aria-hidden="true" />}
      onSelect={() => setDeviceOpen(open => !open)} />
    {deviceOpen && pageLoaded && <div className="ff-browser-menu__sub" role="group" aria-label={t("browserWorkspace.tools.device")}>
      {(["off", "phone", "tablet"] as const).map(preset => <Item key={preset} role="menuitemradio" checked={device === preset}
        icon={preset === "phone" ? <Smartphone size={15} /> : preset === "tablet" ? <Tablet size={15} /> : <Monitor size={15} />}
        label={deviceLabel[preset]} trailing={device === preset ? <Check size={14} aria-hidden="true" /> : undefined} onSelect={() => onDevice(preset)} />)}
    </div>}
    <Item icon={<Camera size={16} />} label={t("browserWorkspace.tools.screenshot")} disabled={!pageLoaded} title={needsPage} onSelect={() => onAction("screenshot")} />
    <div className="ff-browser-menu__separator" role="separator" />
    <Item icon={<Cookie size={16} />} label={t("browserWorkspace.tools.cookies")} onSelect={() => onAction("cookies")} />
    <div className="ff-browser-menu__separator" role="separator" />
    <Item icon={<Download size={16} />} label={t("browserWorkspace.tools.downloads")} onSelect={() => onAction("downloads")} />
    <Item icon={<Clock size={16} />} label={t("browserWorkspace.tools.history")} disabled={!pageLoaded} title={needsPage} onSelect={() => onAction("history")} />
    <Item icon={<Trash2 size={16} />} label={t("browserWorkspace.tools.clearData")} onSelect={() => onAction("clear-data")} />
    <div className="ff-browser-menu__separator" role="separator" />
    <Item icon={<Settings size={16} />} label={t("browserWorkspace.tools.settings")} onSelect={() => onAction("settings")} />
  </div>;
}

export interface BrowserDownloadsPopoverProps {
  downloads: readonly BrowserDownloadDto[];
  onOpen(id: string): void;
  onReveal(id: string): void;
  onCancel(id: string): void;
  onRemove(id: string): void;
  onClear(): void;
  onSettings(): void;
  onClose(): void;
}

export function BrowserDownloadsPopover({ downloads, onOpen, onReveal, onCancel, onRemove, onClear, onSettings, onClose }: BrowserDownloadsPopoverProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); }, []);
  const finished = downloads.some(item => item.state !== "progressing");
  const stateLabel = (item: BrowserDownloadDto): string => item.state === "completed" ? t("browserWorkspace.tools.downloadCompleted")
    : item.state === "failed" ? t("browserWorkspace.tools.downloadFailed") : item.state === "cancelled" ? t("browserWorkspace.tools.downloadCancelled")
    : item.totalBytes > 0 ? t("browserWorkspace.tools.downloadProgress", { received: formatBytes(item.receivedBytes), total: formatBytes(item.totalBytes) }) : formatBytes(item.receivedBytes);
  return <div ref={root} className="ff-browser-popover" role="dialog" aria-label={t("browserWorkspace.tools.downloadsTitle")}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="ff-browser-popover__head">
      <h2>{t("browserWorkspace.tools.downloadsTitle")}</h2>
      <button type="button" aria-label={t("browserWorkspace.tools.downloadsSettings")} title={t("browserWorkspace.tools.downloadsSettings")} onClick={onSettings}><Settings size={15} aria-hidden="true" /></button>
    </div>
    {downloads.length === 0 ? <p className="ff-browser-popover__empty">{t("browserWorkspace.tools.downloadsEmpty")}</p> : <ul className="ff-browser-downloads">
      {downloads.map(item => <li key={item.id} className="ff-browser-download" data-download-state={item.state}>
        <div className="ff-browser-download__text">
          <span className="ff-browser-download__name" title={item.fileName}>{item.fileName}</span>
          <span className="ff-browser-download__meta">{item.host} · {stateLabel(item)}</span>
          {item.state === "progressing" && <progress max={item.totalBytes || undefined} value={item.totalBytes ? item.receivedBytes : undefined} aria-label={item.fileName} />}
        </div>
        <div className="ff-browser-download__actions">
          {item.state === "completed" && <>
            <button type="button" data-download-open={item.id} disabled={!item.openable} title={item.openable ? t("browserWorkspace.tools.downloadOpen") : t("browserWorkspace.tools.downloadNoOpen")}
              aria-label={t("browserWorkspace.tools.downloadOpen")} onClick={() => onOpen(item.id)}><FolderOpen size={15} aria-hidden="true" /></button>
            <button type="button" data-download-reveal={item.id} title={t("browserWorkspace.tools.downloadReveal")} aria-label={t("browserWorkspace.tools.downloadReveal")} onClick={() => onReveal(item.id)}><Search size={15} aria-hidden="true" /></button>
          </>}
          {item.state === "progressing"
            ? <button type="button" data-download-cancel={item.id} title={t("browserWorkspace.tools.downloadCancel")} aria-label={t("browserWorkspace.tools.downloadCancel")} onClick={() => onCancel(item.id)}><X size={15} aria-hidden="true" /></button>
            : <button type="button" data-download-remove={item.id} title={t("browserWorkspace.tools.downloadRemove")} aria-label={t("browserWorkspace.tools.downloadRemove")} onClick={() => onRemove(item.id)}><Trash2 size={15} aria-hidden="true" /></button>}
        </div>
      </li>)}
    </ul>}
    {finished && <div className="ff-browser-popover__foot"><button type="button" data-downloads-clear onClick={onClear}>{t("browserWorkspace.tools.downloadsClear")}</button></div>}
  </div>;
}

export interface BrowserHistoryPopoverProps {
  /** Null while the list is being read. */
  entries: readonly BrowserHistoryEntryDto[] | null;
  onPick(url: string): void;
  onClose(): void;
}

export function BrowserHistoryPopover({ entries, onPick, onClose }: BrowserHistoryPopoverProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); }, [entries]);
  return <div ref={root} className="ff-browser-popover" role="dialog" aria-label={t("browserWorkspace.tools.historyTitle")} onKeyDown={event => arrowNavigation(event, onClose)}>
    <div className="ff-browser-popover__head"><h2>{t("browserWorkspace.tools.historyTitle")}</h2></div>
    {entries !== null && entries.length === 0 ? <p className="ff-browser-popover__empty">{t("browserWorkspace.tools.historyEmpty")}</p> : <ul className="ff-browser-history">
      {(entries ?? []).map(entry => <li key={entry.index}>
        <button type="button" role="menuitem" data-history-index={entry.index} aria-current={entry.current || undefined} title={entry.url} onClick={() => onPick(entry.url)}>
          <span className="ff-browser-history__title">{entry.title || entry.url}</span>
          <span className="ff-browser-history__url">{entry.url}</span>
        </button>
      </li>)}
    </ul>}
  </div>;
}
