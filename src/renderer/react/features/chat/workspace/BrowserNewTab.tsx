import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import bingIcon from "../../../../assets/site-icons/bing.ico";
import wikipediaIcon from "../../../../assets/site-icons/wikipedia.png";
import bilibiliIcon from "../../../../assets/site-icons/bilibili.ico";
import "./BrowserNewTab.css";

/** A workspace entry point offered on the new-tab page. Only real inspector tabs are listed; nothing is a placeholder. */
export interface BrowserNewTabTool {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect(): void;
}
/** Provided by the inspector that hosts the browser, so the page needs no prop chain through the tab components. */
export const BrowserNewTabToolsContext = createContext<readonly BrowserNewTabTool[]>([]);

/** Fixed starting points. Brand names are not translated; each icon is the site's own, shipped with the app so the page stays offline. */
export const BROWSER_START_SITES: readonly { title: string; url: string; icon: string }[] = Object.freeze([
  { title: "Bing", url: "https://www.bing.com/", icon: bingIcon },
  { title: "维基百科", url: "https://zh.wikipedia.org/", icon: wikipediaIcon },
  { title: "哔哩哔哩", url: "https://www.bilibili.com/", icon: bilibiliIcon },
]);

const MAX_RECENT = 8;
const recentHosts = new Map<string, string>();
/** Window-lifetime memory only: never written to disk, cleared when the window's renderer reloads. */
export function rememberVisitedSite(committedUrl: string): void {
  try {
    const url = new URL(committedUrl);
    if (url.protocol !== "https:") return;
    recentHosts.delete(url.hostname);
    recentHosts.set(url.hostname, `${url.origin}/`);
    while (recentHosts.size > MAX_RECENT) recentHosts.delete(recentHosts.keys().next().value as string);
  } catch { /* an unparseable address is simply not remembered */ }
}
export function recentSites(): { title: string; url: string }[] {
  return [...recentHosts.entries()].reverse().map(([title, url]) => ({ title, url }));
}
export function clearRecentSites(): void { recentHosts.clear(); }

function Tile({ title, url, icon, onOpen }: { title: string; url: string; icon?: string; onOpen(url: string): void }) {
  const letter = [...title.replace(/^www\./, "")][0]?.toUpperCase() ?? "?";
  return <button type="button" className="ff-browser-newtab__tile" data-browser-site={url} title={url} onClick={() => onOpen(url)}>
    <span className="ff-browser-newtab__icon" data-favicon={icon ? true : undefined} aria-hidden="true">
      {icon ? <img src={icon} alt="" draggable={false} /> : letter}
    </span>
    <span className="ff-browser-newtab__name">{title}</span>
  </button>;
}

/** Shown in place of a page. Opening a site goes through the same address path as typing it. */
export function BrowserNewTab({ onOpen, available = true }: { onOpen(url: string): void; available?: boolean }) {
  const { t } = useTranslation();
  const recent = recentSites();
  const tools = useContext(BrowserNewTabToolsContext);
  return <div className="ff-browser-newtab" data-browser-newtab data-disabled={!available || undefined}>
    {tools.length > 0 && <section aria-label={t("browserWorkspace.newTabTools")}>
      <h3>{t("browserWorkspace.newTabTools")}</h3>
      <ul className="ff-browser-newtab__tools">{tools.map(tool => <li key={tool.id}>
        <button type="button" className="ff-browser-newtab__tool" data-browser-tool={tool.id} onClick={tool.onSelect}>
          <span className="ff-browser-newtab__tool-icon" aria-hidden="true">{tool.icon}</span>
          <span className="ff-browser-newtab__tool-label">{tool.label}</span>
        </button>
      </li>)}</ul>
    </section>}
    {recent.length > 0 && <section aria-label={t("browserWorkspace.newTabRecent")}>
      <h3>{t("browserWorkspace.newTabRecent")}</h3>
      <div className="ff-browser-newtab__row">{recent.map(site => <Tile key={site.url} {...site} onOpen={onOpen} />)}</div>
    </section>}
    <section aria-label={t("browserWorkspace.newTabSites")}>
      <h3>{t("browserWorkspace.newTabSites")}</h3>
      <div className="ff-browser-newtab__row">{BROWSER_START_SITES.map(site => <Tile key={site.url} {...site} onOpen={onOpen} />)}</div>
    </section>
  </div>;
}
