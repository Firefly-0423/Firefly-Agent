import type { AppUpdateState } from "../../shared/app-update";
type UpdaterEvent = "error" | "checking-for-update" | "update-available" | "update-not-available" | "download-progress" | "update-downloaded";
export type AppUpdaterLike = {
    allowPrerelease: boolean;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    on(eventName: UpdaterEvent, observer: (payload?: any) => void): unknown;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};
type StateListener = (snapshot: AppUpdateState) => void;
export type AppUpdateService = {
    getState(): AppUpdateState;
    check(): Promise<AppUpdateState>;
    download(): Promise<AppUpdateState>;
    canInstall(): boolean;
    install(): boolean;
    onStateChanged(observer: StateListener): () => void;
};
type CreateAppUpdateServiceOptions = {
    updater: AppUpdaterLike;
    currentVersion: string;
    isPackaged: boolean;
    updatesEnabled?: boolean;
    onStateChanged?: StateListener;
};
type StatePatch = Partial<AppUpdateState> & Pick<AppUpdateState, "phase">;
const CHECK_ERROR = "暂时无法检查更新，请稍后再试。";
const DOWNLOAD_ERROR = "更新下载失败，请稍后再试。";
const finiteMetric = (candidate: unknown): number | undefined => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
function releaseText(candidate: unknown): string | null | undefined {
    if (typeof candidate === "string")
        return candidate;
    if (Array.isArray(candidate)) {
        const notes = candidate.map((note) => (typeof note?.note === "string" ? note.note : "")).filter(Boolean);
        return notes.length > 0 ? notes.join("\n\n") : null;
    }
    return candidate === null ? null : undefined;
}
const releaseVersion = (release: any): string | undefined => (typeof release?.version === "string" ? release.version : undefined);
export function createAppUpdateService(ports: CreateAppUpdateServiceOptions): AppUpdateService {
    const { updater: transport, currentVersion: installedVersion, isPackaged: packaged, onStateChanged: stateObserver } = ports;
    const permitted = packaged && ports.updatesEnabled !== false;
    let snapshot: AppUpdateState = { phase: "idle", currentVersion: installedVersion };
    let checkInFlight: Promise<unknown> | null = null;
    let downloadInFlight: Promise<unknown> | null = null;
    const observers = new Set<StateListener>();
    Object.assign(transport, { autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false });
    const publishState = (changes: StatePatch): void => {
        const candidate: AppUpdateState = {
            currentVersion: installedVersion,
            availableVersion: snapshot.availableVersion,
            releaseNotes: snapshot.releaseNotes,
            ...changes,
        };
        if (JSON.stringify(candidate) === JSON.stringify(snapshot))
            return;
        snapshot = candidate;
        stateObserver?.({ ...snapshot });
        for (const observer of observers)
            observer({ ...snapshot });
    };
    const eventHandlers: Record<UpdaterEvent, (payload?: any) => void> = {
        "checking-for-update": () => publishState({ phase: "checking" }),
        "update-available": (release) => publishState({
            phase: "available",
            availableVersion: releaseVersion(release),
            releaseNotes: releaseText(release?.releaseNotes),
        }),
        "update-not-available": () => publishState({ phase: "not_available" }),
        "download-progress": (transfer) => publishState({
            phase: "downloading",
            percent: finiteMetric(transfer?.percent),
            bytesPerSecond: finiteMetric(transfer?.bytesPerSecond),
            transferred: finiteMetric(transfer?.transferred),
            total: finiteMetric(transfer?.total),
        }),
        "update-downloaded": (release) => publishState({
            phase: "downloaded",
            availableVersion: releaseVersion(release) ?? snapshot.availableVersion,
            releaseNotes: releaseText(release?.releaseNotes) ?? snapshot.releaseNotes,
            percent: 100,
        }),
        error: () => publishState({ phase: "error", error: CHECK_ERROR }),
    };
    (Object.keys(eventHandlers) as UpdaterEvent[]).forEach((eventName) => transport.on(eventName, eventHandlers[eventName]));
    return {
        getState: () => ({ ...snapshot }),
        async check() {
            if (!permitted) {
                publishState({ phase: "not_available" });
                return { ...snapshot };
            }
            if (!checkInFlight) {
                publishState({ phase: "checking" });
                checkInFlight = transport.checkForUpdates()
                    .catch(() => {
                    publishState({ phase: "error", error: CHECK_ERROR });
                })
                    .finally(() => {
                    checkInFlight = null;
                });
            }
            await checkInFlight;
            return { ...snapshot };
        },
        async download() {
            if (!permitted)
                return { ...snapshot };
            if (!downloadInFlight && snapshot.phase !== "downloaded") {
                publishState({ phase: "downloading", percent: snapshot.percent ?? 0 });
                downloadInFlight = transport.downloadUpdate()
                    .catch(() => {
                    publishState({ phase: "error", error: DOWNLOAD_ERROR });
                })
                    .finally(() => {
                    downloadInFlight = null;
                });
            }
            await downloadInFlight;
            return { ...snapshot };
        },
        canInstall() {
            return permitted && snapshot.phase === "downloaded";
        },
        install() {
            if (!this.canInstall())
                return false;
            transport.quitAndInstall(true, true);
            return true;
        },
        onStateChanged(observer) {
            observers.add(observer);
            return () => observers.delete(observer);
        },
    };
}
