import { useEffect, useState } from "react";
import type { ModelConnectionSnapshot } from "../../../../../shared/model-connection-types";
import { useTranslation } from "../../../i18n";

export function ModelConnectionIndicator({ activeProfileId, onOpenSettings }: {
  activeProfileId?: string;
  onOpenSettings: () => void;
}) {
  const { t, locale } = useTranslation();
  const [snapshot, setSnapshot] = useState<ModelConnectionSnapshot>();

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const api = window.modelConfig;
    const unsubscribe = api?.onConnectionChanged?.(next => {
      receivedEvent = true;
      if (active) setSnapshot(next);
    });
    void api?.getConnectionSnapshot?.().then(next => {
      // A broadcast may arrive while the initial IPC read is in flight.
      if (active && !receivedEvent) setSnapshot(next);
    }).catch(() => { /* Missing/failed reads remain unverified. */ });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  const profiles = snapshot?.profiles ?? [];
  const connection = profiles.find(profile => profile.profileId === activeProfileId)
    ?? profiles.find(profile => profile.profileId === snapshot?.defaultProfileId)
    ?? profiles[0];
  // A filled-in profile shows green even before a test; a failed last test still shows red.
  const state = connection && ["checking", "connected", "failed"].includes(connection.state)
    ? connection.state : connection?.configured ? "configured" : "unverified";
  const statusKey = {
    unverified: "ui.connectionUnverified", configured: "ui.connectionConfigured", checking: "ui.connectionChecking",
    connected: "ui.connectionConnected", failed: "ui.connectionFailed",
  }[state];
  const label = t("ui.connectionStatus", { state: t(statusKey) });
  const details = [label, t("ui.connectionLastTestNote")];
  if (connection?.checkedAt !== undefined) {
    details.push(t("ui.connectionCheckedAt", { time: new Date(connection.checkedAt).toLocaleString(locale) }));
  }
  if (connection?.reason === "test_failed") details.push(t("ui.connectionTestFailed"));
  if (connection?.reason === "test_error") details.push(t("ui.connectionTestError"));
  details.push(t("ui.connectionOpenSettings"));

  return (
    <button type="button" className="ff-model-connection" data-state={state}
      aria-label={label} title={details.join("\n")} onClick={onOpenSettings}>
      <span className="ff-model-connection__dot" aria-hidden="true" />
      <span className="ff-model-connection__text" role="status">{label}</span>
    </button>
  );
}
