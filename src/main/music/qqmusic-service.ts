import { execFile } from "node:child_process";

export type QqMusicAction = "play" | "pause" | "toggle" | "next" | "previous";
type ScriptAction = "get-state" | "play" | "pause" | "toggle" | "next" | "prev";

export interface QqMusicRawResult {
  ok: boolean;
  found?: boolean;
  appId?: string;
  action?: ScriptAction;
  title?: string;
  artist?: string;
  albumTitle?: string;
  playbackStatus?: string;
  position?: number;
  duration?: number;
  canPlay?: boolean;
  canPause?: boolean;
  canNext?: boolean;
  canPrev?: boolean;
  error?: string;
}

export interface QqMusicState {
  available: boolean;
  errorCode?: string;
  title?: string;
  artist?: string;
  albumTitle?: string;
  playbackStatus?: string;
  position?: number;
  duration?: number;
  canPlay?: boolean;
  canPause?: boolean;
  canNext?: boolean;
  canPrev?: boolean;
}

export interface QqMusicControlResult {
  action: QqMusicAction;
  target: "QQMusic";
  commandSubmission: "accepted" | "rejected" | "not_submitted" | "unknown";
  playerStateObservation: "changed" | "unchanged" | "failed" | "not_observed";
  errorCode?: string;
  observedState?: QqMusicState;
}

export type QqMusicExecutor = (action: ScriptAction, signal?: AbortSignal) => Promise<QqMusicRawResult>;

export function createQqMusicExecutor(scriptPath: string): QqMusicExecutor {
  return (action, signal) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: "CANCELLED" });
      return;
    }
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Action", action], {
      timeout: 4000,
      windowsHide: true,
      signal,
    }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: signal?.aborted ? "CANCELLED" : "QQ_MUSIC_BRIDGE_FAILED" });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim()) as QqMusicRawResult;
        resolve(result && typeof result.ok === "boolean" ? result : { ok: false, error: "QQ_MUSIC_INVALID_RESPONSE" });
      } catch {
        resolve({ ok: false, error: "QQ_MUSIC_INVALID_RESPONSE" });
      }
    });
  });
}

const QQ_SESSION_ID = "qqmusic.exe";

function toState(raw: QqMusicRawResult): QqMusicState {
  if (!raw.ok) return { available: false, errorCode: raw.error || "QQ_MUSIC_BRIDGE_FAILED" };
  if (!raw.found) return { available: false, errorCode: "QQ_MUSIC_SESSION_NOT_FOUND" };
  if (raw.appId?.toLowerCase() !== QQ_SESSION_ID) {
    return { available: false, errorCode: "QQ_MUSIC_WRONG_PLAYER" };
  }
  return {
    available: true,
    title: raw.title || "",
    artist: raw.artist || "",
    albumTitle: raw.albumTitle || "",
    playbackStatus: raw.playbackStatus || "Closed",
    position: raw.position || 0,
    duration: raw.duration || 0,
    canPlay: raw.canPlay === true,
    canPause: raw.canPause === true,
    canNext: raw.canNext === true,
    canPrev: raw.canPrev === true,
  };
}

function observation(action: QqMusicAction, before: QqMusicState, after: QqMusicState): QqMusicControlResult["playerStateObservation"] {
  if (!after.available) return "failed";
  if (action === "next" || action === "previous") {
    return before.title !== after.title || before.artist !== after.artist ? "changed" : "unchanged";
  }
  return before.playbackStatus !== after.playbackStatus ? "changed" : "unchanged";
}

export class QqMusicService {
  constructor(private readonly execute: QqMusicExecutor, private readonly observationDelayMs = 300) {}

  async getState(signal?: AbortSignal): Promise<QqMusicState> {
    return toState(await this.execute("get-state", signal));
  }

  async control(action: QqMusicAction, signal?: AbortSignal): Promise<QqMusicControlResult> {
    const base = { action, target: "QQMusic" as const };
    if (signal?.aborted) return { ...base, commandSubmission: "not_submitted", playerStateObservation: "not_observed", errorCode: "CANCELLED" };
    const before = await this.getState(signal);
    if (!before.available) {
      return { ...base, commandSubmission: "not_submitted", playerStateObservation: "not_observed", errorCode: before.errorCode };
    }
    const enabled = action === "play" ? before.canPlay
      : action === "pause" ? before.canPause
        : action === "next" ? before.canNext
          : action === "previous" ? before.canPrev
            : before.canPlay || before.canPause;
    if (!enabled) return { ...base, commandSubmission: "not_submitted", playerStateObservation: "not_observed", errorCode: "QQ_MUSIC_CONTROL_UNAVAILABLE" };
    if (signal?.aborted) return { ...base, commandSubmission: "not_submitted", playerStateObservation: "not_observed", errorCode: "CANCELLED" };

    const scriptAction = action === "previous" ? "prev" : action;
    const submitted = await this.execute(scriptAction, signal);
    if (!submitted.ok && !submitted.appId) {
      return { ...base, commandSubmission: "unknown", playerStateObservation: "not_observed", errorCode: signal?.aborted ? "CANCELLED_DURING_SUBMISSION" : submitted.error || "QQ_MUSIC_BRIDGE_FAILED" };
    }
    if (!submitted.found) {
      return { ...base, commandSubmission: "not_submitted", playerStateObservation: "not_observed", errorCode: "QQ_MUSIC_SESSION_NOT_FOUND" };
    }
    if (submitted.appId?.toLowerCase() !== QQ_SESSION_ID) {
      return { ...base, commandSubmission: "rejected", playerStateObservation: "not_observed", errorCode: "QQ_MUSIC_WRONG_PLAYER" };
    }
    if (!submitted.ok || submitted.action !== scriptAction) {
      return { ...base, commandSubmission: "rejected", playerStateObservation: "not_observed", errorCode: submitted.error || "QQ_MUSIC_COMMAND_REJECTED" };
    }
    if (signal?.aborted) return { ...base, commandSubmission: "accepted", playerStateObservation: "not_observed", errorCode: "CANCELLED_AFTER_SUBMISSION" };
    if (this.observationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.observationDelayMs));
    if (signal?.aborted) return { ...base, commandSubmission: "accepted", playerStateObservation: "not_observed", errorCode: "CANCELLED_AFTER_SUBMISSION" };
    const after = await this.getState(signal);
    if (signal?.aborted) return { ...base, commandSubmission: "accepted", playerStateObservation: "not_observed", errorCode: "CANCELLED_AFTER_SUBMISSION" };
    return {
      ...base,
      commandSubmission: "accepted",
      playerStateObservation: observation(action, before, after),
      observedState: after,
      ...(!after.available ? { errorCode: after.errorCode } : {}),
    };
  }

  async shutdown(): Promise<{ transportClosed: boolean; processTreeExited: boolean; runtimeRemoved: boolean }> {
    return { transportClosed: true, processTreeExited: true, runtimeRemoved: true };
  }
}
