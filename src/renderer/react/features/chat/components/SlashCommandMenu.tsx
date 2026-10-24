// 输入框里打 "/" 弹出的指令菜单：内置指令（/compact 压缩上下文、/new 新建任务、/clear 清空输入）
// 加上当前模式下可用的技能（选中后把 "/技能id " 填进输入框，发送时由主进程按技能指令处理）。
// 只在输入框里只有一个以 "/" 开头、还没有空格的词时出现；↑↓ 选择，Enter / Tab 确认，Esc 关闭。
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "../../../i18n";
import "./SlashCommandMenu.css";

export interface SlashItem {
  /** What follows the slash, e.g. "compact" or a skill id. */
  name: string;
  description: string;
  kind: "command" | "skill";
}

interface CatalogSkill { id: string; name: string; description: string; descriptionZh?: string; enabled: boolean; modes: string[] | null }

/** The word being typed after "/", or null when the menu should stay closed. */
export function slashQuery(value: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(value);
  return match ? match[1]!.toLowerCase() : null;
}

/** Commands first, then skills; prefix matches before other matches. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const hits = items.filter(item => item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query));
  const rank = (item: SlashItem) => (item.kind === "command" ? 0 : 2) + (item.name.toLowerCase().startsWith(query) ? 0 : 1);
  return hits.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name)).slice(0, 30);
}

function useSkillItems(mode: string): SlashItem[] {
  const [skills, setSkills] = useState<SlashItem[]>([]);
  useEffect(() => {
    if (mode !== "work" && mode !== "code") { setSkills([]); return; }
    const api = (window as typeof window & { settings?: {
      getSkillCatalog?: () => Promise<CatalogSkill[]>;
      getSkillModeOverrides?: () => Promise<Record<string, Partial<Record<string, boolean>>>>;
    } }).settings;
    let active = true;
    // Same precedence as Main's activation: a per-mode override beats the skill's declared modes.
    void Promise.all([api?.getSkillCatalog?.() ?? Promise.resolve([]), api?.getSkillModeOverrides?.().catch(() => ({})) ?? Promise.resolve({})]).then(([catalog, overrides]) => {
      if (!active) return;
      const visible = (skill: CatalogSkill) => {
        const override = (overrides as Record<string, Partial<Record<string, boolean>>>)[skill.id]?.[mode];
        return override ?? (!skill.modes || skill.modes.includes(mode));
      };
      setSkills(catalog
        .filter(skill => skill.enabled && visible(skill))
        .map(skill => ({ name: skill.id, description: (skill.descriptionZh ?? skill.description).split("\n")[0] ?? "", kind: "skill" as const })));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [mode]);
  return skills;
}

export function useSlashCommands({ value, mode, conversationId, busy = false, onChange, onNewTask, onNotice }: {
  value: string;
  /** A run is in flight: /compact is withheld, since compaction rewrites the transcript the run is still writing to. */
  busy?: boolean;
  mode: string;
  conversationId?: string;
  onChange(value: string): void;
  onNewTask?(): void;
  onNotice?(message: string, tone: "success" | "error"): void;
}) {
  const { t } = useTranslation();
  const skills = useSkillItems(mode);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const query = slashQuery(value);
  const commands = useMemo<SlashItem[]>(() => [
    ...(conversationId && !busy ? [{ name: "compact", description: t("slash.compact"), kind: "command" as const }] : []),
    ...(onNewTask ? [{ name: "new", description: t("slash.new"), kind: "command" as const }] : []),
    { name: "clear", description: t("slash.clear"), kind: "command" as const },
  ], [conversationId, busy, onNewTask, t]);
  const items = useMemo(() => (query === null ? [] : filterSlashItems([...commands, ...skills], query)), [query, commands, skills]);
  const open = query !== null && items.length > 0 && dismissed !== value;
  useEffect(() => { setActive(0); }, [query]);

  const run = (item: SlashItem) => {
    if (item.kind === "skill") { onChange(`/${item.name} `); return; }
    onChange("");
    if (item.name === "clear") return;
    if (item.name === "new") { onNewTask?.(); return; }
    if (item.name === "compact" && conversationId && !busy) {
      const store = (window as typeof window & { chatStore?: { compactConversation?: (id: string) => Promise<{ ok?: boolean; error?: string } | undefined> } }).chatStore;
      void store?.compactConversation?.(conversationId)
        .then(result => onNotice?.(t(result?.ok === false ? "slash.compactFailed" : "slash.compactDone"), result?.ok === false ? "error" : "success"))
        .catch(() => onNotice?.(t("slash.compactFailed"), "error"));
    }
  };

  /** Handles the menu's keys; returns true when the key was used. */
  const onKeyDown = (event: KeyboardEvent<Element>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(current => (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (event.key === "Enter" && (event.shiftKey || event.nativeEvent.isComposing)) return false;
      event.preventDefault();
      run(items[Math.min(active, items.length - 1)]!);
      return true;
    }
    if (event.key === "Escape") { event.preventDefault(); setDismissed(value); return true; }
    return false;
  };

  const menu = open ? (
    <div className="ff-slash-anchor">
      <ul className="ff-slash-menu" role="listbox" aria-label={t("slash.label")}>
        {items.map((item, index) => (
          <li key={`${item.kind}:${item.name}`} role="option" aria-selected={index === active}
            className={`ff-slash-menu__item${index === active ? " is-active" : ""}`}
            onMouseEnter={() => setActive(index)}
            onMouseDown={event => { event.preventDefault(); run(item); }}>
            <span className="ff-slash-menu__name">/{item.name}</span>
            <span className="ff-slash-menu__desc">{item.description}</span>
            {item.kind === "skill" && <span className="ff-slash-menu__kind">{t("slash.skill")}</span>}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return { open, menu, onKeyDown };
}
