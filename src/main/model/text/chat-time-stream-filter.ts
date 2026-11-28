/** Probe only the leading metadata, keeping incomplete or invalid prefixes losslessly. */
type TimestampVerdict = "pending" | "matched" | "mismatch";
const STAMP_SHAPE = "[0000-00-00 00:00, ";

function classifyPrefix(candidate: string): TimestampVerdict {
  let position = 0;
  for (const expected of STAMP_SHAPE) {
    if (position === candidate.length) return "pending";
    const actual = candidate[position++];
    const valid = expected === "0" ? /\d/.test(actual) : actual === expected;
    if (!valid) return "mismatch";
  }
  const area = candidate.slice(position);
  const terminator = area.indexOf("]");
  if (terminator < 0) {
    return /^[A-Za-z_]*(?:\/[A-Za-z_+-]*)*$/.test(area) ? "pending" : "mismatch";
  }
  const fullZone = /^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/;
  return terminator === area.length - 1 && fullZone.test(area.slice(0, -1)) ? "matched" : "mismatch";
}

export class ChatTimeStreamPrefixFilter {
  private phase: "probe" | "spaces" | "visible" = "probe";
  private held = "";

  private expose(tail: string): string {
    const released = this.held + tail;
    this.held = "";
    this.phase = "visible";
    return released;
  }

  push(chunk: string): string {
    if (!chunk) return "";
    if (this.phase === "visible") return chunk;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const character = chunk[offset];
      if (this.phase === "spaces") {
        if (/\s/.test(character)) continue;
        if (character !== "[") return this.expose(chunk.slice(offset));
        this.phase = "probe";
        this.held = "[";
        continue;
      }
      this.held += character;
      const verdict = classifyPrefix(this.held);
      if (verdict === "matched") {
        this.held = "";
        this.phase = "spaces";
      } else if (verdict === "mismatch" || this.held.length >= 64) {
        return this.expose(chunk.slice(offset + 1));
      }
    }
    return "";
  }

  finish(): string {
    return this.phase === "probe" ? this.expose("") : "";
  }
}
