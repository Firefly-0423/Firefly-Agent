// ActivityRail — 最左侧 48px 的图标活动轨，参照 Codex 桌面版：
// 顶部是"会话"主页，下面是钉在轨上的全屏面板，"···"弹出全部面板（带名称），每项右侧的图钉决定它是否钉在轨上；
// 底部是本地用户头像（打开设置）。悬停图标时在右侧弹出名称；选中项是一枚 36px 的圆角药丸；
// 侧栏折叠时活动轨仍在。方向键在图标之间移动焦点，Home/End 跳到首尾。钉住哪些面板记在本机。

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover, Tooltip } from "antd";
import { AlarmClock, Blocks, Cpu, Ellipsis, House, PencilRuler, Pin, WandSparkles } from "lucide-react";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import { useUserNickname } from "../../../hooks/useUserNickname";
import { useTranslation } from "../../../i18n";
import type { ChatPagePanel } from "./ChatPageNavigation";
import "./SidebarUserRow.css";
import "./ActivityRail.css";

const ICON = { size: 18, strokeWidth: 1.6 } as const;
const PINNED_KEY = "ff.activityRail.pinned";
export const DEFAULT_RAIL_PINS: readonly ChatPagePanel[] = ["plugin", "skill", "tool"];
const PANELS: readonly ChatPagePanel[] = ["plugin", "skill", "tool", "model", "scheduled"];

function readPins(): ChatPagePanel[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(PINNED_KEY) ?? "null");
    if (Array.isArray(stored)) return PANELS.filter(panel => stored.includes(panel));
  } catch { /* storage unavailable: fall back to the defaults */ }
  return [...DEFAULT_RAIL_PINS];
}
function writePins(pins: readonly ChatPagePanel[]): void {
  try { window.localStorage.setItem(PINNED_KEY, JSON.stringify(pins)); } catch { /* pins then last for this window only */ }
}

export function ActivityRail({ activePanel, onTogglePanel, onOpenSettings }: {
  activePanel: ChatPagePanel | null;
  onTogglePanel(panel: ChatPagePanel): void;
  onOpenSettings(): void;
}) {
  const { t } = useTranslation();
  const avatar = useUserAvatar();
  const nickname = useUserNickname();
  const listRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [pins, setPins] = useState<ChatPagePanel[]>(readPins);
  const [moreOpen, setMoreOpen] = useState(false);
  const panel: Record<ChatPagePanel, { label: string; icon: ReactNode }> = {
    plugin: { label: t("ui.plugins"), icon: <Blocks {...ICON} aria-hidden="true" /> },
    skill: { label: t("ui.skills"), icon: <WandSparkles {...ICON} aria-hidden="true" /> },
    tool: { label: t("ui.tools"), icon: <PencilRuler {...ICON} aria-hidden="true" /> },
    model: { label: t("ui.model"), icon: <Cpu {...ICON} aria-hidden="true" /> },
    scheduled: { label: t("ui.scheduledTasks"), icon: <AlarmClock {...ICON} aria-hidden="true" /> },
  };
  const current = activePanel ?? "home";
  const open = (id: "home" | ChatPagePanel) => {
    if (id === "home") { if (activePanel) onTogglePanel(activePanel); return; }
    if (id !== activePanel) onTogglePanel(id);
  };
  const togglePin = (id: ChatPagePanel) => {
    const next = pins.includes(id) ? pins.filter(item => item !== id) : PANELS.filter(item => item === id || pins.includes(item));
    setPins(next);
    writePins(next);
  };
  const roam = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1
      : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };
  // A panel opened from "···" that is not pinned lights up the "···" button instead.
  const moreActive = activePanel !== null && !pins.includes(activePanel);
  // One rail button is in the tab order: the current one, or "···" when it stands for the current panel.
  const tabStop = moreActive ? "more" : current;
  const name = nickname || t("ui.localUser");
  const railButton = (id: "home" | ChatPagePanel, label: string, icon: ReactNode, divider = false) => (
    <Tooltip key={id} title={label} placement="right" mouseEnterDelay={0.25} rootClassName="ff-activity-rail__tip">
      <button type="button" className="ff-activity-rail__item" data-rail-item={id}
        aria-label={label} aria-current={current === id ? "page" : undefined}
        tabIndex={tabStop === id ? 0 : -1} onClick={() => open(id)} data-divider-after={divider || undefined}>
        {icon}
      </button>
    </Tooltip>
  );
  const moreList = (
    <ul className="ff-activity-rail__menu" aria-label={t("ui.more")} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); setMoreOpen(false); moreRef.current?.focus(); }
    }}>
      {PANELS.map(id => {
        const pinned = pins.includes(id);
        const pinLabel = t(pinned ? "ui.unpinFromRail" : "ui.pinToRail", { name: panel[id].label });
        return (
          <li key={id} className="ff-activity-rail__menu-row" data-pinned={pinned || undefined}>
            <button type="button" className="ff-activity-rail__menu-open" data-rail-menu-item={id} aria-current={activePanel === id ? "page" : undefined}
              onClick={() => { setMoreOpen(false); open(id); }}>
              {panel[id].icon}
              <span>{panel[id].label}</span>
            </button>
            <button type="button" className="ff-activity-rail__menu-pin" aria-pressed={pinned} aria-label={pinLabel} title={pinLabel}
              onClick={() => togglePin(id)}>
              <Pin size={14} strokeWidth={1.6} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
  return (
    <nav className="ff-activity-rail" aria-label={t("ui.activityRail")}>
      <div ref={listRef} className="ff-activity-rail__list" role="toolbar" aria-orientation="vertical" onKeyDown={roam}>
        {railButton("home", t("ui.conversationsHome"), <House {...ICON} aria-hidden="true" />, true)}
        {pins.map(id => railButton(id, panel[id].label, panel[id].icon))}
        <Popover trigger="click" placement="rightTop" open={moreOpen} onOpenChange={setMoreOpen} arrow={false}
          content={moreList} rootClassName="ff-activity-rail__popover">
          <Tooltip title={moreOpen ? undefined : t("ui.more")} placement="right" mouseEnterDelay={0.25} rootClassName="ff-activity-rail__tip">
            <button ref={moreRef} type="button" className="ff-activity-rail__item" data-rail-item="more" aria-label={t("ui.more")}
              aria-haspopup="true" aria-expanded={moreOpen} aria-current={moreActive ? "page" : undefined} tabIndex={tabStop === "more" ? 0 : -1}>
              <Ellipsis {...ICON} aria-hidden="true" />
            </button>
          </Tooltip>
        </Popover>
      </div>
      <Tooltip title={`${name} · ${t("ui.settings")}`} placement="right" mouseEnterDelay={0.25} rootClassName="ff-activity-rail__tip">
        <button type="button" className="ff-activity-rail__user" onClick={onOpenSettings} aria-label={t("ui.userMenu")} aria-description={name}>
          <span className={`ff-user-avatar-circle ${avatar ? "" : "is-placeholder"}`}>
            {avatar ? <img src={avatar} alt={t("ui.userAlt")} draggable={false} /> : <span>U</span>}
          </span>
        </button>
      </Tooltip>
    </nav>
  );
}
