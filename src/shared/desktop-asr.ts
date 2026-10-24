/** Standalone dictation only. No credentials, arbitrary IPC, playback or auto-send. */
export type DesktopAsrError = "unconfigured" | "forbidden" | "invalid_request" | "invalid_audio" | "busy" | "expired" | "cancelled" | "limit" | "timeout" | "service_error";
export type DesktopAsrResult = { ok: true; text?: string } | { ok: false; code: DesktopAsrError };
export interface DesktopAsrApi {
  start(recordingId: string): Promise<DesktopAsrResult>;
  frame(recordingId: string, pcm: Uint8Array): Promise<DesktopAsrResult>;
  stop(recordingId: string): Promise<DesktopAsrResult>;
  cancel(recordingId: string): Promise<DesktopAsrResult>;
}
