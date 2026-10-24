export interface ChatRequestMessage {
  at?: number;
  content: string;
  role: "user" | "model" | "assistant" | "system";
}

export interface ChatCompletionChoice {
  message?: { content?: string };
}

export interface ChatCompletionResponse {
  error?: { message?: string };
  choices?: ChatCompletionChoice[];
}

export function stripThinkBlocks(text: string): string {
  const closed = /<think>[\s\S]*?<\/think>/gi;
  const unfinished = /<think>[\s\S]*$/gi;
  return text.replace(closed, "").replace(unfinished, "").trim();
}

class VisibleTextBuffer {
  private remaining = "";
  private suppress = false;
  private readonly opening = "<think>";
  private readonly closing = "</think>";

  append(fragment: string): string {
    this.remaining += fragment;
    let emitted = "";
    while (this.remaining.length > 0) {
      const marker = this.suppress ? this.closing : this.opening;
      const position = this.remaining.toLowerCase().indexOf(marker);
      if (position < 0) {
        const boundary = Math.max(0, this.remaining.length - marker.length + 1);
        if (!this.suppress) emitted += this.remaining.slice(0, boundary);
        this.remaining = this.remaining.slice(boundary);
        break;
      }
      if (!this.suppress) emitted += this.remaining.slice(0, position);
      this.remaining = this.remaining.slice(position + marker.length);
      this.suppress = !this.suppress;
    }
    return emitted;
  }

  drain(): string {
    const emitted = this.suppress ? "" : this.remaining;
    this.remaining = "";
    // A flush empties text but deliberately does not reset an unclosed think block.
    return emitted;
  }
}

export function createVisibleStreamFilter(): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  const stream = new VisibleTextBuffer();
  return { push: chunk => stream.append(chunk), flush: () => stream.drain() };
}
