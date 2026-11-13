import { it, expect, describe } from "vitest";
import { createSseReader } from "./index";
import type { ChatVendorAdapter, StreamEvent } from "./types";

async function collectFrames(...fragments: string[]) {
  const bytes = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(sink) {
    fragments.forEach((fragment) => sink.enqueue(bytes.encode(fragment)));
    sink.close();
  } });
  const frames: StreamEvent[] = [];
  for await (const frame of createSseReader({} as ChatVendorAdapter, body)) frames.push(frame);
  return frames;
}

describe("SSE byte-stream framing", () => {
  it("discards heartbeat blocks and joins the data lines in one event", async () => {
    await expect(collectFrames(": heartbeat\n\ndata: schedule\ndata: updated\n\n")).resolves.toStrictEqual([
      { eventType: "data", data: "schedule\nupdated" },
    ]);
  });

  it.each([
    ["data: {\"slot\":8}\r\n\r\ndata: {\"slot\":9}\r\n\r\n"],
    ["data: {\"slot\":8}\r", "\n\r", "\ndata: {\"slot\":9}\n", "\n"],
  ])("preserves ordered frames across complete and fragmented CRLF boundaries: %j", async (...fragments) => {
    await expect(collectFrames(...fragments)).resolves.toEqual([
      { eventType: "data", data: '{"slot":8}' }, { eventType: "data", data: '{"slot":9}' },
    ]);
  });
});
