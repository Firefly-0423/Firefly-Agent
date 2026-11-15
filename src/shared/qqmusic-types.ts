/** QQ 音乐控制的进程间契约：主进程的 QqMusicService、preload 和设置页共用。 */
export type QqMusicAction = "play" | "pause" | "toggle" | "next" | "previous";

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
