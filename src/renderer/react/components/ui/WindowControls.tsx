import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n";

interface WindowControlsProps {
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
}

/** The window fills the work area: the middle button then shows "restore" (two squares), as Windows does. */
function useFillsScreen(): boolean {
  const measure = () => typeof window !== "undefined" && typeof screen !== "undefined"
    && window.outerWidth >= screen.availWidth - 1 && window.outerHeight >= screen.availHeight - 1;
  const [fills, setFills] = useState(measure);
  useEffect(() => {
    const update = () => setFills(measure());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return fills;
}

/**
 * Caption buttons drawn like Windows 11's own: three flush 46×32 cells in the window's top-right corner, 1px glyphs in
 * the text colour, a soft fill on hover and the system red behind a white cross for close.
 */
export function WindowControls({ onMinimize, onMaximize, onClose }: WindowControlsProps) {
  const { t } = useTranslation();
  const maximized = useFillsScreen();
  return (
    <div className="ff-window-controls">
      <button type="button" className="ff-winbtn ff-winbtn--minimize" onClick={onMinimize} aria-label={t("ui.minimize")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className="ff-winbtn ff-winbtn--maximize" onClick={onMaximize} aria-label={t("ui.maximizeOrRestore")} data-maximized={maximized || undefined}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
          </svg>
        )}
      </button>
      <button type="button" className="ff-winbtn ff-winbtn--close" onClick={onClose} aria-label={t("ui.closeChatWindow")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
