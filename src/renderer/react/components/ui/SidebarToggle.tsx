import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "../../i18n";

type SidebarToggleProps = { onToggle?: () => void; collapsed?: boolean };

export function SidebarToggle({ collapsed: external, onToggle: notify }: SidebarToggleProps) {
  const { t: translate } = useTranslation();
  const [local, updateLocal] = useState(false);
  const [pointerInside, updatePointer] = useState(false);
  const hidden = external ?? local;
  const flip = () => {
    updateLocal((previous) => !previous);
    notify?.();
  };
  return <button
    className={`ff-sidebar-toggle ${hidden ? "is-collapsed" : ""} ${pointerInside ? "is-hovered" : ""}`}
    onClick={flip} onMouseEnter={() => updatePointer(true)} onMouseLeave={() => updatePointer(false)}
    aria-label={translate("ui.toggleSidebar")} title={`${translate("ui.toggleSidebar")} Ctrl+Shift+S`}
    aria-keyshortcuts="Control+Shift+S" aria-expanded={!hidden} aria-controls="firefly-context-sidebar" type="button"
  >
    {hidden
      ? <PanelLeftOpen size={18} strokeWidth={1.6} aria-hidden="true" />
      : <PanelLeftClose size={18} strokeWidth={1.6} aria-hidden="true" />}
  </button>;
}
