import { Popover } from "antd";
import { useState } from "react";
import { t, useTranslation } from "../../../i18n";
import type { ContextUsageCategoryKey, ContextUsageSnapshot } from "../../../../../shared/context-usage";
import "./ContextUsageRing.css";

const DIAMETER = 20;
const LINE_WIDTH = 3;
const ARC_RADIUS = (DIAMETER - LINE_WIDTH) / 2;
export const RING_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;

interface CompactConversationResult {
  after?: number;
  before?: number;
  error?: string;
  ok: boolean;
}
interface CompactChatApi { compactConversation?: (sessionId: string) => Promise<CompactConversationResult> }
function compactApi(): CompactChatApi | undefined {
  return (window as typeof window & { chatStore?: CompactChatApi }).chatStore;
}

export function contextUsageCategoryMeta(): Record<ContextUsageCategoryKey, { label: string; color: string }> {
  const entries: [ContextUsageCategoryKey, string, string][] = [
    ["systemPrompt", "contextRing.categorySystemPrompt", "#8B5CF6"],
    ["tools", "contextRing.categoryTools", "#3B82F6"],
    ["skills", "contextRing.categorySkills", "#06B6D4"],
    ["runtimeAndToolLogs", "contextRing.categoryRuntimeAndToolLogs", "#F59E0B"],
    ["conversation", "contextRing.categoryConversation", "#10B981"],
    ["other", "contextRing.categoryOther", "#9CA3AF"],
    ["toolDefinitions", "contextRing.categoryToolDefinitions", "#3B82F6"],
    ["retrieved", "contextRing.categoryRetrieved", "#EC4899"],
  ];
  return Object.fromEntries(entries.map(([category, translation, color]) => [category, { label: t(translation), color }])) as Record<ContextUsageCategoryKey, { label: string; color: string }>;
}

export type ContextUsageRingTone = "normal" | "warm" | "alert";
export type ContextCompactPhase = "idle" | "running" | "done" | "error";

export function contextUsageMoodMeta(): Record<ContextUsageRingTone, { text: string }> {
  const levels = ["normal", "warm", "alert"] as const;
  const keys = ["contextRing.moodNormal", "contextRing.moodWarm", "contextRing.moodAlert"];
  return Object.fromEntries(levels.map((category, index) => [category, { text: t(keys[index]) }])) as Record<ContextUsageRingTone, { text: string }>;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) { return "0"; }
  if (value >= 1000) {
    const thousands = value / 1000;
    const display = thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
    return display >= 1000 ? `${Math.round(thousands / 100) / 10}M` : `${display}k`;
  }
  return `${Math.round(value)}`;
}

export function computeUsageRatio(totalTokens: number, contextWindowTokens: number): number {
  const invalidTotal = !Number.isFinite(totalTokens);
  const invalidWindow = !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0;
  return invalidTotal || invalidWindow ? Number.NaN : totalTokens / contextWindowTokens;
}

export function clampVisualRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
}

export function resolveRingTone(ratio: number): ContextUsageRingTone {
  if (Number.isFinite(ratio)) {
    if (ratio >= 0.9) { return "alert"; }
    if (ratio >= 0.7) { return "warm"; }
  }
  return "normal";
}

type ContextUsageRingProps = { busy?: boolean; sessionId?: string; usage?: ContextUsageSnapshot };

function categoryRows(snapshot: ContextUsageSnapshot, metadata: ReturnType<typeof contextUsageCategoryMeta>) {
  const ranked = snapshot.categories.filter((entry) => entry.tokens > 0).sort((left, right) => right.tokens - left.tokens);
  return ranked.map((entry, rank) => {
    const name = metadata[entry.key];
    const percent = snapshot.totalTokens > 0 ? Math.round((entry.tokens / snapshot.totalTokens) * 100) : undefined;
    const opacity = Math.max(0.25, 1 - rank * 0.15);
    return <li key={entry.key}>
      <span className="ff-context-usage-menu__dot" style={{ opacity }} aria-hidden="true" />
      <span className="ff-context-usage-menu__name">{name.label}</span>
      <span className="ff-context-usage-menu__tokens">{formatTokenCount(entry.tokens)}</span>
      {percent !== undefined && <span className="ff-context-usage-menu__share">{percent}%</span>}
    </li>;
  });
}

export function ContextUsageRing({ usage: snapshot, sessionId: session, busy: occupied }: ContextUsageRingProps) {
  const { t: translate } = useTranslation();
  const [shown, show] = useState(false);
  const [phase, changePhase] = useState<ContextCompactPhase>("idle");
  if (!snapshot) return null;

  const fraction = computeUsageRatio(snapshot.totalTokens, snapshot.contextWindowTokens);
  const finite = Number.isFinite(fraction);
  const arc = clampVisualRatio(fraction);
  const level = resolveRingTone(fraction);
  const percent = finite ? `${Math.round(fraction * 100)}%` : undefined;
  const summary = finite
    ? `${formatTokenCount(snapshot.totalTokens)} / ${formatTokenCount(snapshot.contextWindowTokens)} tokens (${percent})`
    : `${formatTokenCount(snapshot.totalTokens)} tokens`;
  const tooltip = translate("contextRing.title", { summary: summary.replace(" tokens ", " ") });
  const eligible = Boolean(session) && !occupied;

  const compress = (): void => {
    if (!eligible || phase === "running" || !session) return;
    const request = compactApi()?.compactConversation;
    if (!request) { changePhase("error"); return; }
    changePhase("running");
    void request(session).then((response) => changePhase(response?.ok ? "done" : "error"))
      .catch(() => changePhase("error"));
  };

  const running = phase === "running";
  const hints = contextUsageMoodMeta();
  const hint = phase === "running" ? translate("contextRing.compactRunning")
    : phase === "done" ? translate("contextRing.compactDone")
    : phase === "error" ? translate("contextRing.compactError") : hints[level].text;
  const metadata = contextUsageCategoryMeta();
  const menuClass = ["ff-context-usage-menu__mood", `is-${level}`, eligible ? "can-compact" : "", running ? "is-compacting" : ""].filter(Boolean).join(" ");
  const menu = <div className="ff-context-usage-menu" aria-label={translate("contextRing.menuAria")}>
    <div className="ff-context-usage-menu__header"><strong>{translate("contextRing.menuTitle")}</strong><span>{summary}</span></div>
    <div className={`ff-context-usage-menu__progress is-${level}`} aria-hidden="true"><span style={{ width: `${arc * 100}%` }} /></div>
    <div className={menuClass}>
      <button type="button" className="ff-context-usage-menu__mood-figure" onClick={compress}
        disabled={!eligible || running} title={eligible ? translate("contextRing.compactTitle") : undefined}
        aria-label={translate("contextRing.compactTitle")}>
        {translate("contextRing.compactTitle")}
      </button>
      <span>{hint}</span>
    </div>
    <ul className="ff-context-usage-menu__rows">{categoryRows(snapshot, metadata)}</ul>
    <div className="ff-context-usage-menu__footnote">{translate("contextRing.footnote")}</div>
  </div>;
  const geometry = { cx: DIAMETER / 2, cy: DIAMETER / 2, r: ARC_RADIUS, fill: "none", strokeWidth: LINE_WIDTH };
  return <Popover content={menu} trigger="click" placement="topRight" open={shown} onOpenChange={show} rootClassName="ff-context-usage-popover">
    <button type="button" className={`ff-context-usage-ring is-${level}`} aria-label={tooltip} title={tooltip} onClick={() => show(!shown)}>
      <svg width={DIAMETER} height={DIAMETER} viewBox={`0 0 ${DIAMETER} ${DIAMETER}`} aria-hidden="true">
        <circle className="ff-context-usage-ring__track" {...geometry} />
        {arc > 0 && <circle className="ff-context-usage-ring__progress" {...geometry} strokeLinecap="round"
          strokeDasharray={`${arc * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`} transform={`rotate(-90 ${DIAMETER / 2} ${DIAMETER / 2})`} />}
      </svg>
    </button>
  </Popover>;
}
