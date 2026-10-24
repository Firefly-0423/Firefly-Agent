import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import { BrowserWorkspacePanel, type BrowserWorkspaceLabels } from "./BrowserWorkspacePanel";
import { createBrowserPageState } from "./browser-page-state";

/** Closed production gate presentation; never creates a guest or navigates. */
export function OfflineBrowserTab({ sessionId, onClose }: { sessionId?: string; onClose(): void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => window.manualBrowser?.getAvailability())
      .catch(() => undefined).then(() => { if (current) setChecked(true); });
    return () => { current = false; };
  }, [sessionId]);
  const labels: BrowserWorkspaceLabels = {
    panel: t("browserWorkspace.title"), address: t("browserWorkspace.address"), go: t("browserWorkspace.go"),
    back: t("browserWorkspace.back"), forward: t("browserWorkspace.forward"), reload: t("browserWorkspace.reload"),
    close: t("browserWorkspace.close"), loading: t("browserWorkspace.checking"),
    blocked: t(checked ? "browserWorkspace.unavailable" : "browserWorkspace.checking"),
    loadFailed: t("browserWorkspace.unavailable"), closed: t("browserWorkspace.closed"),
    viewport: t("browserWorkspace.viewport"), empty: t("browserWorkspace.empty"),
  };
  return <BrowserWorkspacePanel page={{ ...createBrowserPageState(sessionId ?? "", "offline"), error: "blocked" }}
    address={address} labels={labels} navigationAvailable={false} onAddressChange={setAddress}
    onNavigate={() => {}} onCommand={() => {}} onClose={onClose} />;
}
