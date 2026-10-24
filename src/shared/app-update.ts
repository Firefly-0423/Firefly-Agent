export const APP_UPDATE_PHASES = [
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "not_available",
  "error",
] as const;

export type AppUpdatePhase = (typeof APP_UPDATE_PHASES)[number];

export type AppUpdateState = {
  error?: string;
  releaseNotes?: string | null;
  total?: number;
  transferred?: number;
  bytesPerSecond?: number;
  percent?: number;
  availableVersion?: string;
  currentVersion: string;
  phase: AppUpdatePhase;
};

type StateListener = (state: AppUpdateState) => void;

export type AppUpdateApi = {
  onStateChanged(listener: StateListener): () => void;
  install(): Promise<boolean>;
  download(): Promise<AppUpdateState>;
  getState(): Promise<AppUpdateState>;
};
