import { Popover } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";

type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";
interface PermissionSettingsApi {
  setPermissionLevel?: (level: PermissionLevel) => Promise<{ ok: boolean; level?: PermissionLevel }>;
  getPermissionLevel?: () => Promise<{ level: PermissionLevel }>;
}
const PERMISSION_OPTIONS: ReadonlyArray<{ level: PermissionLevel; labelKey: string; descKey: string }> = [
  ["read-only", "permission.levelReadOnly", "permission.descReadOnly"],
  ["per-action", "permission.levelPerAction", "permission.descPerAction"],
  ["full", "permission.levelFull", "permission.descFull"],
].map(([level, labelKey, descKey]) => ({ level: level as PermissionLevel, labelKey, descKey }));
const KNOWN_LEVELS: ReadonlyArray<{ level: PermissionLevel; labelKey: string }> = [
  ...PERMISSION_OPTIONS,
  ...([ ["project-read-only", "permission.levelProjectReadOnly"], ["scoped", "permission.levelScoped"] ] as const)
    .map(([level, labelKey]) => ({ level, labelKey })),
];

function permissionApi(): PermissionSettingsApi | undefined {
  return (window as typeof window & { settings?: PermissionSettingsApi }).settings;
}

function PermissionIcon({ level: choice }: { level: PermissionLevel }) {
  const shield = <path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" />;
  switch (choice) {
    case "scoped": return <svg viewBox="0 0 48 48" aria-hidden="true">{shield}<path d="M14 21h8l2.5 3H34v8H14v-11Z" /></svg>;
    case "per-action": return <svg viewBox="0 0 48 48" aria-hidden="true">{shield}<circle cx="22" cy="22" r="6" /><path d="m26.5 26.5 5 5" /></svg>;
    case "full": return <svg viewBox="0 0 48 48" aria-hidden="true">{shield}<path d="M24 15v14" /><circle cx="24" cy="35" r="1.4" fill="currentColor" stroke="none" /></svg>;
    default: return <svg viewBox="0 0 48 48" aria-hidden="true">{shield}<path d="m15 23 7 7 12-12" /></svg>;
  }
}

function labelFor(choice: PermissionLevel, translate: (key: string) => string): string {
  const match = KNOWN_LEVELS.find((candidate) => candidate.level === choice);
  return translate(match?.labelKey ?? "permission.levelReadOnly");
}

export function PermissionControl() {
  const { t: translate } = useTranslation();
  const [selected, updateSelection] = useState<PermissionLevel>("read-only");
  const [expanded, expand] = useState(false);
  const reload = async () => {
    try {
      const reply = await permissionApi()?.getPermissionLevel?.();
      if (reply) updateSelection(reply.level);
    } catch { updateSelection("read-only"); }
  };
  useEffect(() => { void reload(); }, []);

  const choose = async (target: PermissionLevel) => {
    try {
      const reply = await permissionApi()?.setPermissionLevel?.(target);
      if (reply?.ok) updateSelection(reply.level ?? target);
      expand(false);
    } catch { await reload(); }
  };
  const panel = <div className="ff-permission-panel">
    <strong className="ff-permission-panel__title">{translate("permission.panelQuestion")}</strong>
    <div className="ff-permission-panel__options" role="radiogroup" aria-label={translate("permission.panelTitle")}>
      {PERMISSION_OPTIONS.map((candidate) => <button type="button" role="radio" aria-checked={selected === candidate.level} key={candidate.level}
        className={`ff-permission-panel__option is-${candidate.level} ${selected === candidate.level ? "is-active" : ""}`}
        onClick={() => void choose(candidate.level)}>
        <span className="ff-permission-panel__icon"><PermissionIcon level={candidate.level} /></span>
        <span className="ff-permission-panel__text"><span className="ff-permission-panel__label">{translate(candidate.labelKey)}</span><small>{translate(candidate.descKey)}</small></span>
        <svg className="ff-permission-panel__check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
      </button>)}
    </div>
  </div>;
  return <Popover trigger="click" placement="topLeft" open={expanded}
    onOpenChange={(shown) => { expand(shown); if (shown) void reload(); }}
    overlayClassName="ff-permission-popover" content={panel}>
    <button type="button" className={`ff-composer__footer-button ff-permission-control is-${selected}`}>
      <PermissionIcon level={selected} /><span>{labelFor(selected, translate)}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </button>
  </Popover>;
}
