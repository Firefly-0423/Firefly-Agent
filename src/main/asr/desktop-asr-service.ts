import type { DesktopAsrError, DesktopAsrResult } from "../../shared/desktop-asr";
import type { AsrConfig } from "./asr-config";
import type { AsrStreamSession } from "./asr-dispatcher";

export const DESKTOP_ASR_LIMITS = Object.freeze({ recordingMs: 120_000, operationMs: 30_000, maxFrameBytes: 16_000, maxBytes: 3_840_000, maxFrames: 3_000 });
interface Recording {
  id: string;
  stream: AsrStreamSession;
  phase: "starting" | "recording" | "stopping";
  bytes: number;
  frames: number;
  timer?: ReturnType<typeof setTimeout>;
  interrupted: Promise<DesktopAsrResult>;
  interrupt: (result: DesktopAsrResult) => void;
}
const failure = (code: DesktopAsrError): DesktopAsrResult => ({ ok: false, code });
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(id);
function configured(config: AsrConfig | null): config is AsrConfig {
  return !!config && (config.engine === "mossland" ? !!config.apiKey.trim()
    : config.engine === "aliyun" && !!config.appKey.trim() && !!config.accessKeyId.trim() && !!config.accessKeySecret.trim());
}

/** Main-owned, memory-only, bounded recordings. Owners are trusted WebContents IDs. */
export class DesktopAsrService {
  private readonly recordings = new Map<number, Recording>();
  private disposed = false;
  constructor(private readonly deps: { getConfig: () => AsrConfig | null; createStream: (config: AsrConfig) => AsrStreamSession }) {}

  async start(owner: number, id: unknown): Promise<DesktopAsrResult> {
    if (this.disposed) return failure("expired");
    if (!validId(id)) return failure("invalid_request");
    if (this.recordings.has(owner)) return failure("busy");
    let session: Recording;
    try {
      const config = this.deps.getConfig();
      if (!configured(config)) return failure("unconfigured");
      let interrupt!: Recording["interrupt"];
      const interrupted = new Promise<DesktopAsrResult>(resolve => { interrupt = resolve; });
      session = { id, stream: this.deps.createStream(config), phase: "starting", bytes: 0, frames: 0, interrupted, interrupt };
      this.recordings.set(owner, session);
      this.arm(owner, session, DESKTOP_ASR_LIMITS.operationMs);
      const result = await Promise.race([session.stream.start().then((): DesktopAsrResult => ({ ok: true })), interrupted]);
      if (!result.ok) return result;
      if (this.recordings.get(owner) !== session) return failure("cancelled");
      session.phase = "recording";
      this.arm(owner, session, DESKTOP_ASR_LIMITS.recordingMs);
      return { ok: true };
    } catch {
      this.cancel(owner, id);
      return failure("service_error");
    }
  }

  frame(owner: number, id: unknown, frame: unknown): DesktopAsrResult {
    const session = this.owned(owner, id);
    if (!session || session.phase !== "recording") return failure("expired");
    if (!(frame instanceof Uint8Array) || !frame.byteLength || frame.byteLength % 2 || frame.byteLength > DESKTOP_ASR_LIMITS.maxFrameBytes) {
      this.cancel(owner, id); return failure("invalid_audio");
    }
    if (session.bytes + frame.byteLength > DESKTOP_ASR_LIMITS.maxBytes || session.frames >= DESKTOP_ASR_LIMITS.maxFrames) {
      this.cancel(owner, id); return failure("limit");
    }
    session.bytes += frame.byteLength; session.frames++;
    try { session.stream.sendAudio(Buffer.from(frame)); return { ok: true }; }
    catch { this.cancel(owner, id); return failure("service_error"); }
  }

  async stop(owner: number, id: unknown): Promise<DesktopAsrResult> {
    const session = this.owned(owner, id);
    if (!session || session.phase !== "recording") return failure("expired");
    session.phase = "stopping";
    this.arm(owner, session, DESKTOP_ASR_LIMITS.operationMs);
    try {
      const result = await Promise.race([
        Promise.resolve(session.stream.stop()).then((text): DesktopAsrResult => ({ ok: true, text: typeof text === "string" ? text.slice(0, 32_000).trim() : "" })),
        session.interrupted,
      ]);
      if (!result.ok) return result;
      return this.recordings.get(owner) === session ? result : failure("cancelled");
    } catch { return failure("service_error"); }
    finally { if (this.recordings.get(owner) === session) this.release(owner, session, "cancelled"); }
  }

  cancel(owner: number, id: unknown): DesktopAsrResult {
    const session = this.owned(owner, id);
    if (session) this.release(owner, session, "cancelled");
    return { ok: true };
  }
  cancelOwner(owner: number): void { const session = this.recordings.get(owner); if (session) this.release(owner, session, "cancelled"); }
  cancelAll(): void { for (const owner of this.recordings.keys()) this.cancelOwner(owner); }
  dispose(): void { this.disposed = true; this.cancelAll(); }
  private owned(owner: number, id: unknown): Recording | undefined { const session = this.recordings.get(owner); return validId(id) && session?.id === id ? session : undefined; }
  private arm(owner: number, session: Recording, delay: number): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => { if (this.recordings.get(owner) === session) this.release(owner, session, "timeout"); }, delay);
    session.timer.unref?.();
  }
  private release(owner: number, session: Recording, reason: DesktopAsrError): void {
    this.recordings.delete(owner); clearTimeout(session.timer);
    session.interrupt(failure(reason));
    try { session.stream.cancel(); } catch { /* Release ownership even if the provider cleanup fails. */ }
  }
}
