/** The AudioContext resamples microphone input to 16 kHz before this processor. */
class DesktopDictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = new Uint8Array(6400);
    this.view = new DataView(this.pcm.buffer);
    this.offset = 0;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data === "flush") { this.flush(); this.active = false; this.port.postMessage({ flushed: true }); }
      if (data === "cancel") { this.active = false; this.offset = 0; }
    };
  }
  flush() {
    if (!this.offset) return;
    const pcm = this.pcm.slice(0, this.offset);
    this.port.postMessage({ pcm }, [pcm.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.view.setInt16(this.offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      this.offset += 2;
      if (this.offset === this.pcm.length) this.flush();
    }
    // Outputs remain silent; microphone audio is never played back.
    return true;
  }
}
registerProcessor("desktop-dictation", DesktopDictationProcessor);
