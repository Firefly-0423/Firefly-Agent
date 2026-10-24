import type { DictationCapture } from "./desktop-asr-controller";

/** Standard browser permission flow; no device bypass and no persisted audio.
 * https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
 */
export async function openDictationMicrophone(signal: AbortSignal, onFrame: (pcm: Uint8Array) => void, onError: (code: string) => void): Promise<DictationCapture> {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let closed = false;
  let tracksStopped = false;
  let flushDone: (() => void) | undefined;
  const stopTracks = (): void => { if (tracksStopped) return; tracksStopped = true; for (const track of stream.getTracks()) { track.removeEventListener("ended", ended); track.stop(); } };
  const cleanup = (): void => {
    if (closed) return; closed = true;
    signal.removeEventListener("abort", cleanup); stopTracks();
    source?.disconnect();
    if (node) { node.port.postMessage("cancel"); node.port.onmessage = null; node.port.close(); node.disconnect(); }
    void context?.close().catch(() => {}); flushDone?.();
  };
  const ended = (): void => { if (!closed) { cleanup(); onError("microphone_error"); } };
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    // Web Audio performs device-rate → 16 kHz conversion, including 44.1/48 kHz devices.
    context = new AudioContext({ sampleRate: 16_000 });
    if (context.sampleRate !== 16_000) throw new Error("Unsupported recording sample rate");
    await context.audioWorklet.addModule(new URL("./desktop-asr-worklet.js?no-inline", import.meta.url).href);
    if (closed || signal.aborted) throw new DOMException("Cancelled", "AbortError");
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "desktop-dictation");
    node.port.onmessage = ({ data }: MessageEvent<{ pcm?: Uint8Array; flushed?: boolean }>) => {
      if (closed) return;
      if (data.pcm instanceof Uint8Array && data.pcm.byteLength <= 6400) onFrame(data.pcm);
      if (data.flushed) flushDone?.();
    };
    node.addEventListener("processorerror", ended);
    for (const track of stream.getTracks()) track.addEventListener("ended", ended, { once: true });
    source.connect(node); node.connect(context.destination);
    await context.resume();
    if (closed || signal.aborted) throw new DOMException("Cancelled", "AbortError");
    return {
      cancel: cleanup,
      stop: async () => {
        if (closed) return;
        stopTracks(); source?.disconnect();
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Audio flush timed out")), 1000);
            flushDone = () => { clearTimeout(timeout); resolve(); };
            node!.port.postMessage("flush");
          });
        } finally { cleanup(); }
      },
    };
  } catch (error) { cleanup(); throw error; }
}
