export class StreamController {
  private pending = "";
  bufferProgressContent(content: string): void { this.pending += content; }
  getBuffered(): string { return this.pending; }
  discardProgressBuffer(): void { this.pending = ""; }
  flushProgressBufferAsProgress(): string | null {
    if (!this.pending) return null;
    const progress = this.pending;
    this.pending = "";
    return progress;
  }
  commitProgressBuffer(): string {
    const captured = this.pending;
    this.pending = "";
    return captured;
  }
  hasBufferedContent(): boolean { return this.pending.length > 0; }
}
