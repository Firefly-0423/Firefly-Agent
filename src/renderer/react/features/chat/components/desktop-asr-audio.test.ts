import fs from "node:fs";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { openDictationMicrophone } from "./desktop-asr-audio";
afterEach(() => vi.unstubAllGlobals());
it("worklet converts stereo float samples into bounded little-endian 16 kHz mono PCM and flushes its tail", () => {
  let Processor: any; const sent: any[] = [];
  vm.runInNewContext(fs.readFileSync(new URL("./desktop-asr-worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { postMessage: (message: any) => sent.push(message), onmessage: null }; },
    registerProcessor: (_name: string, ctor: any) => { Processor = ctor; }, Float32Array, Uint8Array, ArrayBuffer, DataView, Math,
  });
  let processor = new Processor();
  processor.process([[new Float32Array([1, -1, 0.5, 2]), new Float32Array([1, -1, -0.5, 2])]]);
  processor.port.onmessage({ data: "flush" });
  expect(Array.from(sent[0].pcm)).toEqual([255,127,0,128,0,0,255,127]); expect(sent[1]).toEqual({ flushed: true });
  sent.length=0; processor = new Processor(); processor.process([[new Float32Array(6401)]]); processor.port.onmessage({ data: "flush" });
  expect(sent.filter(x => x.pcm).map(x => x.pcm.byteLength)).toEqual([6400,6400,2]);
  processor.port.onmessage({ data: "cancel" }); expect(processor.process([[new Float32Array(128)]])).toBe(false);
});
function browser() {
  const events: string[] = []; let processor: any;
  const track = { stop: () => events.push("track.stop"), addEventListener: () => {}, removeEventListener: () => {} };
  const stream = { getTracks: () => [track] };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async (constraints: any) => { expect(constraints.video).toBe(false); events.push("microphone"); return stream; } } });
  vi.stubGlobal("AudioContext", class {
    sampleRate = 16000; destination = {};
    constructor(options: any) { expect(options.sampleRate).toBe(16000); }
    audioWorklet = { addModule: async () => { events.push("module"); } };
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => events.push("source.disconnect") }; }
    resume() { return Promise.resolve(); }
    close() { events.push("context.close"); return Promise.resolve(); }
  });
  vi.stubGlobal("AudioWorkletNode", class {
    port = { onmessage: null as any, postMessage: (message: any) => { if (message === "flush") { this.port.onmessage({ data: { pcm: new Uint8Array([0,0]) } }); this.port.onmessage({ data: { flushed: true } }); } }, close: () => events.push("port.close") };
    constructor() { processor = this; }
    connect() {} disconnect() { events.push("node.disconnect"); }
    addEventListener() {} removeEventListener() {}
  });
  return { events, stream, processor: () => processor };
}
it("normal microphone capture flushes PCM before stopping all resources", async () => {
  const h=browser(); const frames: Uint8Array[]=[];
  const capture = await openDictationMicrophone(new AbortController().signal, pcm => frames.push(pcm), () => {});
  await capture.stop(); expect(frames).toHaveLength(1); capture.cancel();
  expect(h.events.filter(x => x === "track.stop")).toHaveLength(1); expect(h.events).toContain("context.close"); expect(h.events).toContain("port.close");
});
it("aborts late permission results without constructing audio nodes", async () => {
  const h=browser(); let resolve!: (stream: any) => void;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(r => { resolve=r; }) } });
  const abort=new AbortController(); const opening=openDictationMicrophone(abort.signal, () => {}, () => {}); abort.abort(); resolve(h.stream);
  await expect(opening).rejects.toMatchObject({ name: "AbortError" }); expect(h.events).toEqual(["track.stop"]);
});
it("cleans permission-granted microphone when worklet setup fails", async () => {
  const h=browser(); vi.stubGlobal("AudioContext", class { constructor() { throw new Error("unsupported sample rate"); } });
  await expect(openDictationMicrophone(new AbortController().signal, () => {}, () => {})).rejects.toThrow("unsupported sample rate"); expect(h.events).toContain("track.stop");
});
