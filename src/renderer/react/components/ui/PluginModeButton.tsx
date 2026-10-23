import { Puzzle } from "lucide-react";
import { useTranslation } from "../../i18n";

type PluginModeButtonProps = {
  onClick?: () => void;
  active?: boolean;
};

export function PluginModeButton(props: PluginModeButtonProps) {
  const { active = false, onClick } = props;
  const { t } = useTranslation();
  const label = t("ui.plugins");
  return <button className={`ff-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={label} aria-label={label} aria-pressed={active}>
    <span className="ff-side-action-icon"><Puzzle size={16} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="ff-side-action-label">{label}</span>
  </button>;
}
