import { Wrench } from "lucide-react";
import { useTranslation } from "../../i18n";

type ToolModeButtonProps = {
  onClick?: () => void;
  active?: boolean;
};

export function ToolModeButton(props: ToolModeButtonProps) {
  const { active = false, onClick } = props;
  const { t } = useTranslation();
  const label = t("ui.tools");
  return <button className={`ff-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={label} aria-pressed={active}>
    <span className="ff-side-action-icon"><Wrench size={16} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="ff-side-action-label">{label}</span>
  </button>;
}
