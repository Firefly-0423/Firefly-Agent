import React, { type ReactNode, type Ref } from "react";
import { ArrowLeft, ArrowRight, CornerDownLeft, RotateCw, Square, X } from "lucide-react";
import type { BrowserPageState } from "./browser-page-state";
import "./BrowserWorkspacePanel.css";

export interface BrowserWorkspaceLabels {
  panel: string;
  address: string;
  go: string;
  back: string;
  forward: string;
  reload: string;
  stop?: string;
  close: string;
  loading: string;
  blocked: string;
  loadFailed: string;
  closed: string;
  viewport: string;
  empty: string;
  committedUrl?: string;
  addressHint?: string;
  addressPlaceholder?: string;
}

export interface BrowserWorkspacePanelProps {
  page: BrowserPageState;
  address: string;
  labels: BrowserWorkspaceLabels;
  onAddressChange: (value: string) => void;
  onNavigate: (url: string) => void;
  onAddressReset?: () => void;
  commandPending?: boolean;
  closeAvailable?: boolean;
  onCommand: (command: "back" | "forward" | "reload" | "stop") => void;
  onClose: () => void;
  viewportRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
  navigationAvailable?: boolean;
  /** Address proposals can be available before native site consent; history still needs a grant. */
  addressAvailable?: boolean;
  /** Shown where a page would be while the tab is empty. Presentation only. */
  emptyContent?: ReactNode;
  /** Extra toolbar controls (downloads, more menu) between the address field and the close control. */
  toolbarEnd?: ReactNode;
  /** Rows under the toolbar: find bar and short notices. */
  belowToolbar?: ReactNode;
  /** Menus and pages drawn over the page area. */
  overlay?: ReactNode;
  /** Picture of the page standing in for it while the native page is detached behind an overlay. */
  snapshot?: string | null;
}

/** Controlled view: no bridge, navigation API, authority, or asynchronous work. */
export function BrowserWorkspacePanel({
  page, address, labels, onAddressChange, onAddressReset, onNavigate, onCommand, onClose, viewportRef, children, navigationAvailable = true, addressAvailable = navigationAvailable && !page.closed, commandPending = false, closeAvailable = !page.closed, emptyContent, toolbarEnd, belowToolbar, overlay, snapshot,
}: BrowserWorkspacePanelProps) {
  const busy = page.loading || commandPending;
  const canSubmit = addressAvailable && address.trim().length > 0;
  return (
    <section className="ff-browser-workspace" aria-label={labels.panel} data-browser-command-pending={commandPending || undefined}>
      <div className="ff-browser-workspace__toolbar" data-browser-busy={busy && !page.closed || undefined}>
        <div className="ff-browser-workspace__nav" role="group" aria-label={labels.panel}>
          <button type="button" aria-label={labels.back} title={labels.back}
            disabled={!navigationAvailable || page.closed || !page.canGoBack} onClick={() => onCommand("back")}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label={labels.forward} title={labels.forward}
            disabled={!navigationAvailable || page.closed || !page.canGoForward} onClick={() => onCommand("forward")}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        {busy ? <button type="button" className="ff-browser-workspace__reload" aria-label={labels.stop} title={labels.stop}
          disabled={!navigationAvailable || page.closed || page.requestId === 0} onClick={() => onCommand("stop")}>
          <Square size={14} aria-hidden="true" />
        </button> : <button type="button" className="ff-browser-workspace__reload" aria-label={labels.reload} title={labels.reload}
          disabled={!navigationAvailable || page.closed || !page.url} onClick={() => onCommand("reload")}>
          <RotateCw size={16} aria-hidden="true" />
        </button>}
        <form className="ff-browser-workspace__address" onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onNavigate(address.trim());
        }}>
          <input type="text" inputMode="url" autoComplete="off" spellCheck={false}
            aria-label={labels.address} placeholder={labels.addressPlaceholder ?? "https://"} title={labels.addressHint} value={address} disabled={page.closed && !addressAvailable}
            onChange={(event) => onAddressChange(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Escape" && onAddressReset) { event.preventDefault(); event.stopPropagation(); onAddressReset(); } }} />
          <button type="submit" aria-label={labels.go} title={labels.go} disabled={!canSubmit}><CornerDownLeft size={14} aria-hidden="true" /></button>
        </form>
        {toolbarEnd}
        <button type="button" aria-label={labels.close} title={labels.close}
          disabled={!closeAvailable} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {page.url && !page.closed && <div className="ff-browser-workspace__location" aria-label={labels.committedUrl}>
        <span className="ff-browser-workspace__location-dot" aria-hidden="true" />
        <span data-browser-committed-url title={page.url}>{page.url}</span>
      </div>}
      {belowToolbar}
      {page.closed
        ? <p className="ff-browser-workspace__notice" role="status">{labels.closed}</p>
        : <>
          {busy && <p className="ff-browser-workspace__notice" role="status">{labels.loading}</p>}
          {page.error && <p className="ff-browser-workspace__notice is-error" role="alert">
            {page.error === "blocked" ? labels.blocked : labels.loadFailed}
          </p>}
          <div className="ff-browser-workspace__viewport" ref={viewportRef} role="region"
            aria-label={labels.viewport} aria-busy={busy}>
            {children ?? (!page.url && !page.loading
              ? emptyContent ?? <p className="ff-browser-workspace__empty">{labels.empty}</p>
              : null)}
            {snapshot && <img className="ff-browser-workspace__snapshot" src={snapshot} alt="" draggable={false} />}
            {overlay}
          </div>
        </>}
    </section>
  );
}
