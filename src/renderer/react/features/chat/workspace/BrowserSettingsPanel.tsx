import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { BrowserClearKind, BrowserCookieDomainDto, BrowserToolSettings } from "../../../../../shared/browser-tools";

export type BrowserSettingsSection = "downloads" | "cookies" | "clear";

export interface BrowserSettingsPanelProps {
  section: BrowserSettingsSection;
  settings: BrowserToolSettings | null;
  /** Null while the cookie summary is being read. */
  cookies: readonly BrowserCookieDomainDto[] | null;
  /** A short result line (cleared, failed...) shown at the bottom. */
  status: string | null;
  busy: boolean;
  onAskWhere(value: boolean): void;
  onChooseFolder(): void;
  onResetFolder(): void;
  onClearSite(domain: string): void;
  onClear(kinds: readonly BrowserClearKind[]): void;
  onClose(): void;
}

/** The browser's settings page. It covers the page area, so it is a page of its own rather than a floating menu. */
export function BrowserSettingsPanel({ section, settings, cookies, status, busy, onAskWhere, onChooseFolder, onResetFolder, onClearSite, onClear, onClose }: BrowserSettingsPanelProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [kinds, setKinds] = useState<Record<BrowserClearKind, boolean>>({ cookies: true, cache: true, storage: false });
  useEffect(() => {
    const target = root.current?.querySelector<HTMLElement>(`[data-settings-section="${section}"]`);
    target?.scrollIntoView?.({ block: "start" });
    root.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [section]);
  const total = cookies?.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const chosen = (Object.keys(kinds) as BrowserClearKind[]).filter(kind => kinds[kind]);
  return <div ref={root} className="ff-browser-settings" role="dialog" aria-label={t("browserWorkspace.tools.settingsTitle")}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="ff-browser-settings__head">
      <h2>{t("browserWorkspace.tools.settingsTitle")}</h2>
      <button type="button" aria-label={t("browserWorkspace.tools.settingsClose")} title={t("browserWorkspace.tools.settingsClose")} data-settings-close onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <div className="ff-browser-settings__body">
      <section data-settings-section="downloads" aria-labelledby="ff-browser-settings-downloads">
        <h3 id="ff-browser-settings-downloads">{t("browserWorkspace.tools.sectionDownloads")}</h3>
        <div className="ff-browser-settings__row">
          <div><span className="ff-browser-settings__label">{t("browserWorkspace.tools.folderLabel")}</span>
            <span className="ff-browser-settings__value" data-download-folder>{settings?.downloadFolderName ?? t("browserWorkspace.tools.folderDefault")}</span></div>
          <div className="ff-browser-settings__buttons">
            <button type="button" data-folder-change disabled={!settings || busy} onClick={onChooseFolder}>{t("browserWorkspace.tools.folderChange")}</button>
            {settings?.downloadFolderName != null && <button type="button" data-folder-reset disabled={busy} onClick={onResetFolder}>{t("browserWorkspace.tools.folderReset")}</button>}
          </div>
        </div>
        <label className="ff-browser-settings__row ff-browser-settings__check">
          <span>{t("browserWorkspace.tools.askWhere")}</span>
          <input type="checkbox" data-ask-where checked={settings?.askWhereToSave ?? false} disabled={!settings || busy} onChange={event => onAskWhere(event.currentTarget.checked)} />
        </label>
        <p className="ff-browser-settings__hint">{t("browserWorkspace.tools.downloadsHint")}</p>
      </section>

      <section data-settings-section="cookies" aria-labelledby="ff-browser-settings-cookies">
        <h3 id="ff-browser-settings-cookies">{t("browserWorkspace.tools.sectionCookies")}</h3>
        <p className="ff-browser-settings__hint">{t("browserWorkspace.tools.cookiesHint")}</p>
        {cookies === null ? null : cookies.length === 0 ? <p className="ff-browser-settings__empty">{t("browserWorkspace.tools.cookiesEmpty")}</p> : <>
          <p className="ff-browser-settings__summary" role="status">{t("browserWorkspace.tools.cookiesSummary", { count: total, sites: cookies.length })}</p>
          <ul className="ff-browser-cookies">
            {cookies.map(item => <li key={item.domain}>
              <span className="ff-browser-cookies__domain" title={item.domain}>{item.domain}</span>
              <span className="ff-browser-cookies__count">{item.count}</span>
              <button type="button" data-cookie-clear={item.domain} disabled={busy} onClick={() => onClearSite(item.domain)}>{t("browserWorkspace.tools.cookieClearSite")}</button>
            </li>)}
          </ul>
          <div className="ff-browser-settings__buttons"><button type="button" data-cookies-clear-all disabled={busy} onClick={() => onClear(["cookies"])}>{t("browserWorkspace.tools.cookiesClearAll")}</button></div>
        </>}
      </section>

      <section data-settings-section="clear" aria-labelledby="ff-browser-settings-clear">
        <h3 id="ff-browser-settings-clear">{t("browserWorkspace.tools.sectionClear")}</h3>
        {(["cookies", "cache", "storage"] as const).map(kind => <label key={kind} className="ff-browser-settings__row ff-browser-settings__check">
          <span>{t(kind === "cookies" ? "browserWorkspace.tools.clearCookies" : kind === "cache" ? "browserWorkspace.tools.clearCache" : "browserWorkspace.tools.clearStorage")}</span>
          <input type="checkbox" data-clear-kind={kind} checked={kinds[kind]} onChange={event => { const value = event.currentTarget.checked; setKinds(current => ({ ...current, [kind]: value })); }} />
        </label>)}
        <div className="ff-browser-settings__buttons"><button type="button" className="is-primary" data-clear-run disabled={busy || chosen.length === 0} onClick={() => onClear(chosen)}>{t("browserWorkspace.tools.clearRun")}</button></div>
      </section>
      {status && <p className="ff-browser-settings__status" role="status">{status}</p>}
    </div>
  </div>;
}
