import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTranslation } from "../../i18n";
import "./NavigationArrows.css";

/** Back / forward through the places already visited (conversations and full-page panels), like the arrows in a browser or Codex. */
export function NavigationArrows({ canBack, canForward, onBack, onForward }: {
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="ff-nav-arrows" role="group" aria-label={t("ui.navHistory")}>
      <button type="button" className="ff-nav-arrows__button" disabled={!canBack} onClick={onBack}
        aria-label={t("ui.navBack")} title={t("ui.navBack")}>
        <ArrowLeft size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>
      <button type="button" className="ff-nav-arrows__button" disabled={!canForward} onClick={onForward}
        aria-label={t("ui.navForward")} title={t("ui.navForward")}>
        <ArrowRight size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>
    </div>
  );
}
