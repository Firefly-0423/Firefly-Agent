import { BrainCircuit } from "lucide-react";
import { useTranslation } from "../../i18n";

type ModelModeButtonProps = {
  onClick?: () => void;
  active?: boolean;
};

export function ModelModeButton(props: ModelModeButtonProps) {
  const { active = false, onClick } = props;
  const { t } = useTranslation();
  const label = t("ui.model");
  return <button className={`ff-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={label} aria-pressed={active}>
    <span className="ff-side-action-icon"><BrainCircuit size={16} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="ff-side-action-label">{label}</span>
  </button>;
}
