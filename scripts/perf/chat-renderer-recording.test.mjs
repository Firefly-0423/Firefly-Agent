import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingFileName, installLiveMessageFollow, createRecordingContextOptions } from "./chat-renderer-recording.mjs";

test("recording options reserve the fixed capture geometry only for an output directory", () => {
  assert.deepEqual(createRecordingContextOptions(), {});
  assert.deepEqual(createRecordingContextOptions("D:/captures/review"), {
    recordVideo: { size: { height: 900, width: 1440 }, dir: "D:/captures/review" },
    viewport: { height: 900, width: 1440 },
  });
});

test("the replay filename includes dataset, position, rendering mode and run number", () => {
  assert.equal(recordingFileName({ streamRender: "animated", scroll: "top", count: 24, dataset: "tables" }, 3),
    "tables-24-top-animated-run-3.webm");
});

test("the follow loop waits for streaming before scrolling to the latest message", t => {
  const saved = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  t.after(() => Object.assign(globalThis, saved));
  const scheduled = [];
  const viewport = { scrollTop: 0, scrollHeight: 1536 };
  const selectors = [];
  Object.assign(globalThis, {
    window: { __perfState: "hydrated" },
    document: { querySelector: selector => { selectors.push(selector); return viewport; } },
    requestAnimationFrame: callback => scheduled.push(callback),
  });
  installLiveMessageFollow();
  scheduled.shift()();
  assert.equal(viewport.scrollTop, 0);
  globalThis.window.__perfState = "streaming";
  scheduled.shift()();
  assert.equal(viewport.scrollTop, 1536);
  assert.deepEqual(selectors, [".ff-message-list"]);
});
