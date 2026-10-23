import { useState } from "react";
import { useTranslation } from "../../i18n";
import "./InspectorToggle.css";

type InspectorToggleProps = { onToggle: () => void; open: boolean };

export function InspectorToggle({ open: expanded, onToggle: toggle }: InspectorToggleProps) {
  const { t: translate } = useTranslation();
  const [pointerInside, setPointerInside] = useState(false);
  const outline = { stroke: "currentColor", strokeWidth: "3.5", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return <button
    className={`ff-inspector-toggle ${expanded ? "is-open" : ""} ${pointerInside ? "is-hovered" : ""}`}
    onClick={toggle} onMouseEnter={() => setPointerInside(true)} onMouseLeave={() => setPointerInside(false)}
    aria-label={translate("rightInspector.toggle")} aria-expanded={expanded}
  >
    <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="6" width="36" height="36" rx="3" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" />
      <path className="ff-inspector-line" d="M24 6V42" {...outline} />
      <path d="M11 6H36" {...outline} />
      <path d="M11 42H36" {...outline} />
      <path className="ff-inspector-chevron" d="M16 20L20 24L16 28" {...outline} />
    </svg>
  </button>;
}
