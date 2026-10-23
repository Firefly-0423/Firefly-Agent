import { Sparkles } from "lucide-react";
import { useTranslation } from "../../i18n";

type SkillModeButtonProps = { onClick?: () => void; active?: boolean };

export function SkillModeButton({ active: selected = false, onClick: activate }: SkillModeButtonProps) {
  const { t: translate } = useTranslation();
  return <button
    className={`ff-side-action ${selected ? "is-active" : ""}`} onClick={activate} type="button"
    title={translate("ui.skills")} aria-pressed={selected}
  >
    <span className="ff-side-action-icon"><Sparkles size={16} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="ff-side-action-label">{translate("ui.skills")}</span>
  </button>;
}
