import { SquarePen } from "lucide-react";
import { useTranslation } from "../../i18n";

type NewTaskButtonProps = { onClick?: () => void; label?: string };

export function NewTaskButton({ label: caption, onClick: activate }: NewTaskButtonProps) {
  const { t: translate } = useTranslation();
  const content = caption ?? translate("ui.newButton");
  return <button className="ff-side-action" onClick={activate} type="button">
    <span className="ff-side-action-icon"><SquarePen size={16} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="ff-side-action-label">{content}</span>
  </button>;
}
