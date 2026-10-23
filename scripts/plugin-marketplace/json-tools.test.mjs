import assert from "node:assert/strict";
import test from "node:test";
import { sandboxTools } from "./plugin-fixture.mjs";

async function tools() {
  const { call, tools: registry } = await sandboxTools("json-tools");
  return {
    validate: text => call("json-tools_validate", { text }),
    compare: (left, right) => call("json-tools_compare", { left, right }),
    registry,
  };
}

test("validate accepts lossless JSON of every root type and names the root type", async () => {
  const { validate } = await tools();
  const cases = [
    ['{"a":[1,2,{"b":null}]}', "object"], ["[1,2]", "array"], ['"text"', "string"],
    ["12.5", "number"], ["true", "boolean"], ["null", "null"], [" \n{} \t", "object"],
  ];
  for (const [text, type] of cases) assert.deepEqual(await validate(text), { valid: true, type }, text);
});

test("validate reports syntax errors with a stable reason and a bounded message", async () => {
  const { validate } = await tools();
  for (const text of ["", "{", "{'a':1}", "[1,]", "NaN", "undefined", '{"a":1}{"b":2}', "01"]) {
    const result = await validate(text);
    assert.equal(result.valid, false, text);
    assert.equal(result.reason, "syntax", text);
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0 && result.message.length <= 300);
  }
});

test("validate rejects values JSON cannot round-trip: negative zero and overflow to infinity, with the JSON path", async () => {
  const { validate } = await tools();
  assert.deepEqual(await validate("-0"), { valid: false, reason: "lossy", path: "$", message: "negative zero is not preserved" });
  assert.deepEqual(await validate('{"a":[1,{"b":-0.0}]}'), { valid: false, reason: "lossy", path: "$.a[1].b", message: "negative zero is not preserved" });
  assert.deepEqual(await validate('{"odd key":1e999}'), { valid: false, reason: "lossy", path: '$["odd key"]', message: "number is not finite" });
  assert.deepEqual(await validate("[0, 0.0, 1e-7, 9007199254740991]"), { valid: true, type: "array" });
});

test("validate handles very deep nesting without recursion limits", async () => {
  const { validate } = await tools();
  const depth = 5000;
  const text = "[".repeat(depth) + "-0" + "]".repeat(depth);
  const result = await validate(text);
  // V8 may refuse to parse this deep; either outcome must be a structured answer, never a thrown stack overflow.
  assert.equal(result.valid, false);
  assert.ok(["syntax", "lossy"].includes(result.reason));
  const shallow = await validate("[".repeat(500) + "1" + "]".repeat(500));
  assert.deepEqual(shallow, { valid: true, type: "array" });
});

test("compare ignores key order and number spelling, and reports equal documents", async () => {
  const { compare } = await tools();
  assert.deepEqual(await compare('{"a":1,"b":[1,2,{"c":"x"}]}', '{ "b":[1,2,{"c":"x"}], "a":1.0 }'), { equal: true });
  assert.deepEqual(await compare("[]", "[]"), { equal: true });
  assert.deepEqual(await compare("null", "null"), { equal: true });
});

test("compare reports the first difference with a path and kind", async () => {
  const { compare } = await tools();
  assert.deepEqual(await compare('{"a":[1,2,3]}', '{"a":[1,2,4]}'), { equal: false, difference: { path: "$.a[2]", kind: "value" } });
  assert.deepEqual(await compare('{"a":[1,2]}', '{"a":[1,2,3]}'), { equal: false, difference: { path: "$.a", kind: "length" } });
  assert.deepEqual(await compare('{"a":1}', '{"a":"1"}'), { equal: false, difference: { path: "$.a", kind: "type" } });
  assert.deepEqual(await compare('{"a":1,"b":2}', '{"a":1}'), { equal: false, difference: { path: "$.b", kind: "missing-in-right" } });
  assert.deepEqual(await compare('{"a":1}', '{"a":1,"c":{}}'), { equal: false, difference: { path: "$.c", kind: "missing-in-left" } });
  assert.deepEqual(await compare("[1]", '{"0":1}'), { equal: false, difference: { path: "$", kind: "type" } });
  assert.deepEqual(await compare('{"a b":{"x":null}}', '{"a b":{"x":false}}'), { equal: false, difference: { path: '$["a b"].x', kind: "type" } });
});

test("compare uses own keys only: inherited names and __proto__ are ordinary data", async () => {
  const { compare } = await tools();
  assert.deepEqual(await compare('{"toString":1}', "{}"), { equal: false, difference: { path: "$.toString", kind: "missing-in-right" } });
  assert.deepEqual(await compare('{"__proto__":1}', "{}"), { equal: false, difference: { path: "$.__proto__", kind: "missing-in-right" } });
  assert.deepEqual(await compare('{"__proto__":{"a":1}}', '{"__proto__":{"a":1}}'), { equal: true });
  assert.deepEqual(await compare('{"constructor":1}', '{"constructor":1}'), { equal: true });
});

test("compare refuses documents that are not lossless JSON and says which side", async () => {
  const { registry } = await tools();
  const compare = registry.get("json-tools_compare");
  await assert.rejects(compare.execute({ left: "{", right: "{}" }), /left is not valid JSON/);
  await assert.rejects(compare.execute({ left: "{}", right: "[-0]" }), /right is not lossless JSON.*\$\[0\]/);
});

test("compare handles deep documents iteratively", async () => {
  const { compare } = await tools();
  const make = tail => "[".repeat(400) + tail + "]".repeat(400);
  const result = await compare(make("1"), make("2"));
  assert.equal(result.equal, false);
  assert.equal(result.difference.kind, "value");
  assert.ok(result.difference.path.startsWith("$[0][0]"));
});

test("rejects non-string arguments instead of coercing and caps input size", async () => {
  const { registry } = await tools();
  const validate = registry.get("json-tools_validate");
  const compare = registry.get("json-tools_compare");
  for (const args of [{}, { text: 1 }, { text: null }, null, undefined, { text: {} }]) {
    await assert.rejects(validate.execute(args), /text must be a string/);
  }
  for (const args of [{ left: "{}" }, { left: "{}", right: 2 }, { left: 1, right: "{}" }, null]) {
    await assert.rejects(compare.execute(args), /left and right must be strings/);
  }
  await assert.rejects(validate.execute({ text: " ".repeat(1_000_001) }), /at most 1000000 characters/);
  await assert.rejects(compare.execute({ left: "{}", right: " ".repeat(1_000_001) }), /at most 1000000 characters/);
});
