export type OpenInAppEntry = { icon?: string; name: string; id: string };
export type OpenInAppListResult =
  | { preferred: string; apps: OpenInAppEntry[]; ok: true }
  | { code: "NO_WORKSPACE" | "DETECT_FAILED"; ok: false };
export type OpenInAppOpenResult = { ok: true } | {
  error?: string;
  code: "NO_WORKSPACE" | "WORKSPACE_MISSING" | "APP_NOT_FOUND" | "LAUNCH_FAILED";
  ok: false;
};
