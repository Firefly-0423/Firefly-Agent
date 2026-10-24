import assert from "node:assert/strict";
import test from "node:test";
import { sandboxTools } from "./plugin-fixture.mjs";

async function tools() {
  const { call, tools: registry } = await sandboxTools("text-trim");
  return { cap: args => call("text-trim_cap", args), run: args => registry.get("text-trim_cap").execute(args) };
}

const utf8 = text => new TextEncoder().encode(text).length;

test("head keeps a prefix within the byte budget and reports exact omitted bytes", async () => {
  const { cap } = await tools();
  assert.deepEqual(await cap({ text: "abcdefghij", strategy: "head", maxBytes: 4 }), {
    text: "abcd", truncated: true, totalBytes: 10, keptBytes: 4, omittedBytes: 6, notice: "Omitted 6 bytes.",
  });
  assert.deepEqual(await cap({ text: "abcdefghij", maxBytes: 10 }), { text: "abcdefghij", truncated: false, totalBytes: 10, keptBytes: 10, omittedBytes: 0, notice: "" });
  assert.deepEqual(await cap({ text: "", maxBytes: 0 }), { text: "", truncated: false, totalBytes: 0, keptBytes: 0, omittedBytes: 0, notice: "" });
  assert.deepEqual((await cap({ text: "abc", maxBytes: 0 })).text, "");
});

test("tail keeps a suffix", async () => {
  const { cap } = await tools();
  assert.deepEqual(await cap({ text: "abcdefghij", strategy: "tail", maxBytes: 3 }), {
    text: "hij", truncated: true, totalBytes: 10, keptBytes: 3, omittedBytes: 7, notice: "Omitted 7 bytes.",
  });
});

test("headTail keeps both ends and marks the gap, counting only retained content as kept", async () => {
  const { cap } = await tools();
  assert.deepEqual(await cap({ text: "abcdefghij", strategy: "headTail", headBytes: 3, tailBytes: 2 }), {
    text: "abc\n[... omitted 5 bytes ...]\nij", truncated: true, totalBytes: 10, keptBytes: 5, omittedBytes: 5, notice: "Omitted 5 bytes.",
  });
  // The two budgets cover the whole text: nothing is cut and no marker is added.
  assert.deepEqual(await cap({ text: "abcdefghij", strategy: "headTail", headBytes: 6, tailBytes: 4 }), {
    text: "abcdefghij", truncated: false, totalBytes: 10, keptBytes: 10, omittedBytes: 0, notice: "",
  });
  assert.equal((await cap({ text: "abcdefghij", strategy: "headTail", headBytes: 0, tailBytes: 0 })).text, "\n[... omitted 10 bytes ...]\n");
});

test("cuts land on UTF-8 boundaries and the omission count reflects the bytes actually dropped", async () => {
  const { cap } = await tools();
  // "é" is 2 bytes, "世" 3 bytes, "😀" 4 bytes.
  const text = "aé世😀z";
  assert.equal(utf8(text), 11);
  const head = await cap({ text, strategy: "head", maxBytes: 4 });
  assert.equal(head.text, "aé");
  assert.deepEqual([head.keptBytes, head.omittedBytes, head.totalBytes], [3, 8, 11]);
  assert.equal((await cap({ text, strategy: "head", maxBytes: 6 })).text, "aé世");
  assert.equal((await cap({ text, strategy: "head", maxBytes: 10 })).text, "aé世😀");
  const tail = await cap({ text, strategy: "tail", maxBytes: 5 });
  assert.equal(tail.text, "😀z");
  assert.deepEqual([tail.keptBytes, tail.omittedBytes], [5, 6]);
  assert.equal((await cap({ text, strategy: "tail", maxBytes: 4 })).text, "z");
  const both = await cap({ text, strategy: "headTail", headBytes: 2, tailBytes: 4 });
  assert.equal(both.text, "a\n[... omitted 9 bytes ...]\nz");
  assert.deepEqual([both.keptBytes, both.omittedBytes], [2, 9]);
  for (const result of [head, tail, both]) assert.ok(!result.text.includes("�"));
});

test("a lone surrogate counts as the three bytes its replacement character takes in UTF-8", async () => {
  const { cap } = await tools();
  const text = "a\uD800b";
  assert.equal(utf8(text), 5);
  const result = await cap({ text, strategy: "head", maxBytes: 3 });
  assert.equal(result.text, "a");
  assert.equal(result.totalBytes, 5);
});

test("agrees with a reference TextEncoder implementation on mixed text for every budget", async () => {
  const { cap } = await tools();
  const text = "Hello, 世界! 😀 café\nline two ✓";
  const total = utf8(text);
  const bytes = new TextEncoder().encode(text);
  for (let budget = 0; budget <= total + 2; budget++) {
    let end = Math.min(budget, total);
    while (end > 0 && end < total && (bytes[end] & 0xc0) === 0x80) end--;
    const expected = new TextDecoder().decode(bytes.subarray(0, end));
    const head = await cap({ text, strategy: "head", maxBytes: budget });
    assert.equal(head.text, expected, `head ${budget}`);
    assert.equal(head.keptBytes + head.omittedBytes, total);
    let start = Math.max(total - budget, 0);
    while (start < total && (bytes[start] & 0xc0) === 0x80) start++;
    const tail = await cap({ text, strategy: "tail", maxBytes: budget });
    assert.equal(tail.text, new TextDecoder().decode(bytes.subarray(start)), `tail ${budget}`);
    assert.equal(tail.keptBytes + tail.omittedBytes, total);
  }
});

test("validates arguments instead of coercing or guessing budgets", async () => {
  const { run } = await tools();
  for (const args of [{}, { text: 1, maxBytes: 3 }, { text: null, maxBytes: 3 }, null, undefined]) await assert.rejects(run(args), /text must be a string/);
  await assert.rejects(run({ text: "x" }), /maxBytes must be a non-negative integer/);
  for (const maxBytes of [-1, 1.5, "3", NaN, Infinity, null]) await assert.rejects(run({ text: "x", maxBytes }), /maxBytes must be a non-negative integer/);
  await assert.rejects(run({ text: "x", strategy: "middle", maxBytes: 1 }), /strategy must be one of head, tail, headTail/);
  await assert.rejects(run({ text: "x", strategy: "headTail", maxBytes: 3 }), /headBytes and tailBytes must be non-negative integers/);
  await assert.rejects(run({ text: "x", strategy: "headTail", headBytes: 1, tailBytes: -1 }), /headBytes and tailBytes must be non-negative integers/);
  await assert.rejects(run({ text: "x", strategy: "head", maxBytes: 1, headBytes: 1 }), /headBytes and tailBytes are only for headTail/);
  await assert.rejects(run({ text: "x", strategy: "headTail", headBytes: 1, tailBytes: 1, maxBytes: 1 }), /maxBytes is not used with headTail/);
  await assert.rejects(run({ text: "x".repeat(1_000_001), maxBytes: 5 }), /at most 1000000 characters/);
});
