import { describe, it, expect } from "vitest";
import { resolveCompletedFile, parseHelperEvent } from "./protocol";

describe("Capture wire format", () => {
  const id = "capture-ticket-73";
  const done = { type: "completed", requestId: id, fileName: null, width: 1, height: 1,
    mime: "image/png", clipboardWritten: true, hasAnnotations: false };

  it.each([
    { type: "cancelled", requestId: id, reason: "escape" },
    { type: "error", requestId: null, code: "capture-failed", message: "display disconnected", recoverable: false },
    done,
    { type: "capture-released", requestId: id, width: 960, height: 540, clipboardWritten: true },
    { type: "interaction-state", requestId: id, state: "selecting" },
    { type: "overlay-visible", requestId: id, freezeDurationMs: 0 },
    { type: "accepted", requestId: id },
    { type: "ready", protocolVersion: 1 },
    { ...done, hasAnnotations: true },
  ])("decodes the complete $type payload", (wire) => {
    expect(parseHelperEvent(JSON.stringify(wire))).toEqual(wire);
  });

  it.each([
    { ...done, fileName: 18, width: 0, mime: "image/jpeg", clipboardWritten: "true" },
    { ...done, fileName: "..\\private.png", hasAnnotations: undefined },
    { type: "interaction-state", requestId: id, state: "drawing" },
    { ...done, width: 0 },
    { ...done, height: 0 },
    { ...done, width: 4294967296 },
    { ...done, hasAnnotations: undefined },
    { ...done, clipboardWritten: "true" },
    { ...done, mime: "image/jpeg" },
    { type: "ready", protocolVersion: 0 },
    { type: "overlay-visible", requestId: id, freezeDurationMs: -1 },
    { type: "accepted", requestId: "" },
    null, [], { type: "unrecognized" },
  ])("rejects invalid event data %j", (wire) => {
    expect(() => parseHelperEvent(JSON.stringify(wire))).toThrow("INVALID_HELPER_EVENT");
  });

  it("rejects malformed JSON with the protocol error", () => {
    expect(() => parseHelperEvent("{invalid JSON")).toThrow("INVALID_HELPER_EVENT");
  });
});

describe("Capture output containment", () => {
  it.each(["..\\private.png", "b7c6d5e4-f3a2-1b09-8c87-766554433221.png"])("rejects a name outside the v4 PNG contract: %s", (file) => {
    expect(() => resolveCompletedFile("D:\\captures", file)).toThrow("INVALID_SCREENSHOT_FILE_NAME");
  });

  it.runIf(process.platform === "win32")("anchors a v4 UUID file to the requested directory", () => {
    expect(resolveCompletedFile("D:\\captures", "b7c6d5e4-f3a2-4b09-8c87-766554433221.png"))
      .toEqual("D:\\captures\\b7c6d5e4-f3a2-4b09-8c87-766554433221.png");
  });
});
