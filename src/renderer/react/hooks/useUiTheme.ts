import { useEffect, useState } from "react";
import { DEFAULT_UI_THEME, normalizeUiTheme, type UiTheme } from "../../../shared/ui-theme";

function readTheme(): UiTheme {
  return typeof document === "undefined" ? DEFAULT_UI_THEME : normalizeUiTheme(document.documentElement.dataset.uiTheme);
}

/** The theme currently applied to <html>. `ui/theme.ts` owns the attribute; this only follows it. */
export function useUiTheme(): UiTheme {
  const [theme, setTheme] = useState<UiTheme>(readTheme);
  useEffect(() => {
    const update = () => setTheme(readTheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
