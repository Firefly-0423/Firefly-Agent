import { Download, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import type { AppUpdateState } from "../../../../../shared/app-update";
import "./AppUpdateEntry.css";

export interface AppUpdateEntryView {
  disabled: boolean;
  action: "download" | "install" | null;
  label: string;
}

export function resolveAppUpdateEntryView(snapshot: AppUpdateState): AppUpdateEntryView | null {
  if (snapshot.phase === "available") {
    const caption = snapshot.availableVersion
      ? t("appUpdate.availableWithVersion", { version: snapshot.availableVersion })
      : t("appUpdate.available");
    return { label: caption, action: "download", disabled: false };
  }
  if (snapshot.phase === "downloading") {
    const progress = Math.max(0, Math.min(100, Math.round(snapshot.percent ?? 0)));
    return { label: t("appUpdate.downloading", { percent: progress }), action: null, disabled: true };
  }
  if (snapshot.phase === "downloaded") {
    return { label: t("appUpdate.restart"), action: "install", disabled: false };
  }
  return null;
}

export function AppUpdateEntry() {
  const bridge = window.appUpdate;
  const [snapshot, updateSnapshot] = useState<AppUpdateState>({ phase: "idle", currentVersion: "" });
  useEffect(() => {
    if (!bridge) return;
    let listening = true;
    const receive = (next: AppUpdateState) => { if (listening) updateSnapshot(next); };
    void bridge.getState().then(receive);
    const detach = bridge.onStateChanged(receive);
    return () => { listening = false; detach(); };
  }, [bridge]);

  const presentation = resolveAppUpdateEntryView(snapshot);
  if (!bridge || !presentation) return null;
  const activate = () => {
    if (presentation.action === "download") void bridge.download();
    if (presentation.action === "install") void bridge.install();
  };
  return <button
    type="button" className={`ff-app-update-entry is-${snapshot.phase}`}
    disabled={presentation.disabled} onClick={activate} title={snapshot.releaseNotes || presentation.label}
  >
    {snapshot.phase === "downloaded" ? <RotateCcw size={15} /> : <Download size={15} />}
    <span>{presentation.label}</span>
    {snapshot.phase === "downloading" && <span className="ff-app-update-entry__progress"
      style={{ width: `${Math.max(0, Math.min(100, snapshot.percent ?? 0))}%` }} />}
  </button>;
}
