import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import "./PanelShell.css";

/**
 * Codex-style full-page features: the left sidebar swaps to the feature's own navigation while the main area holds the page.
 * A page keeps all its state in one component, so it hands its sidebar over through a portal into this slot instead of
 * lifting that state up. Without a slot (a page rendered on its own) the sidebar simply renders inline above the page.
 */
export const PanelSidebarSlotContext = createContext<HTMLElement | null>(null);

export interface PanelSidebarProps {
  title: string;
  /** Icon buttons on the title row (refresh, import, …). */
  actions?: ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder: string; className?: string };
  /** The primary "+ New …" row under the search field. */
  primary?: ReactNode;
  children?: ReactNode;
}

export function PanelSidebar({ title, actions, search, primary, children }: PanelSidebarProps) {
  const slot = useContext(PanelSidebarSlotContext);
  const body = (
    <nav className={`ff-panel-sidebar${slot ? "" : " is-inline"}`} aria-label={title}>
      <div className="ff-panel-sidebar__head">
        <h2 className="ff-panel-sidebar__title">{title}</h2>
        {actions && <div className="ff-panel-sidebar__actions">{actions}</div>}
      </div>
      {search && (
        <label className="ff-panel-sidebar__search">
          <Search size={14} strokeWidth={1.7} aria-hidden="true" />
          <input className={search.className} value={search.value} placeholder={search.placeholder} aria-label={search.placeholder}
            onChange={event => search.onChange(event.target.value)} />
        </label>
      )}
      {primary && <div className="ff-panel-sidebar__primary">{primary}</div>}
      <div className="ff-panel-sidebar__body">{children}</div>
    </nav>
  );
  return slot ? createPortal(body, slot) : body;
}

export function PanelSidebarSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="ff-panel-sidebar__section" role="group" aria-label={title}>
      {title && <div className="ff-panel-sidebar__caption">{title}</div>}
      {children}
    </div>
  );
}

export interface PanelSidebarItemProps {
  icon?: ReactNode;
  label: string;
  active?: boolean;
  count?: number;
  disabled?: boolean;
  /** A small status dot before the label (e.g. an enabled schedule). */
  dot?: "on" | "off";
  onClick: () => void;
}

export function PanelSidebarItem({ icon, label, active, count, disabled, dot, onClick }: PanelSidebarItemProps) {
  return (
    <button type="button" className="ff-panel-sidebar__item" aria-pressed={active} disabled={disabled} onClick={onClick}>
      {icon && <span className="ff-panel-sidebar__item-icon" aria-hidden="true">{icon}</span>}
      {dot && <span className={`ff-panel-sidebar__dot is-${dot}`} aria-hidden="true" />}
      <span className="ff-panel-sidebar__item-label">{label}</span>
      {count !== undefined && <span className="ff-panel-sidebar__count">{count}</span>}
    </button>
  );
}

/** The "+ New …" row: quiet, with a plus icon, like Codex's. */
export function PanelPrimaryButton({ icon, label, onClick, disabled }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="ff-panel-sidebar__new" disabled={disabled} onClick={onClick}>
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function PanelIconButton({ label, children, onClick, disabled, accent }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; accent?: boolean }) {
  return (
    <button type="button" className={`ff-panel-iconbtn${accent ? " is-accent" : ""}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** The main-area page: a centred column with a title, an optional subtitle and the page's own actions. */
export function PanelPage({ className, title, subtitle, actions, children }: { className?: string; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={`ff-panel-page ${className ?? ""}`}>
      <div className="ff-panel-page__column">
        <header className="ff-panel-page__header">
          <div className="ff-panel-page__heading">
            <h1 className="ff-panel-page__title">{title}</h1>
            {subtitle && <p className="ff-panel-page__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="ff-panel-page__actions">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export interface PanelSuggestion { icon: ReactNode; title: string; description: string; onClick: () => void; disabled?: boolean }

/** A centred empty state with suggestion cards, like Codex's first-run pages. */
export function PanelEmpty({ icon, title, hint, suggestions }: { icon: ReactNode; title: string; hint?: string; suggestions?: PanelSuggestion[] }) {
  return (
    <div className="ff-panel-empty">
      <span className="ff-panel-empty__icon" aria-hidden="true">{icon}</span>
      <h2 className="ff-panel-empty__title">{title}</h2>
      {hint && <p className="ff-panel-empty__hint">{hint}</p>}
      {suggestions && suggestions.length > 0 && (
        <div className="ff-panel-empty__cards">
          {suggestions.map(card => (
            <button key={card.title} type="button" className="ff-panel-empty__card" disabled={card.disabled} onClick={card.onClick}>
              <span className="ff-panel-empty__card-icon" aria-hidden="true">{card.icon}</span>
              <span className="ff-panel-empty__card-title">{card.title}</span>
              <span className="ff-panel-empty__card-desc">{card.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
