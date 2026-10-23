import assert from "node:assert/strict";
import test from "node:test";
import { assertNoLeakage, buildDataset, sessionText } from "./dataset.mjs";

test("the dataset is deterministic for a given seed and size", () => {
  const a = buildDataset({ size: 80, seed: 1 });
  const b = buildDataset({ size: 80, seed: 1 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.sessions.at(-1), buildDataset({ size: 80, seed: 2 }).sessions.at(-1));
});

test("filler never contains a query keyword and every gold session exists", () => {
  for (const size of [60, 300, 512]) assertNoLeakage(buildDataset({ size }));
});

test("the core cases are always present and the corpus grows with size", () => {
  const small = buildDataset({ size: 10 });
  const large = buildDataset({ size: 200 });
  assert.equal(large.sessions.length, 200);
  assert.ok(small.sessions.length >= 130, "core sessions are never dropped");
  assert.deepEqual(small.queries, large.queries);
});

test("query categories cover paraphrase, correction, needle, temporal and no-answer", () => {
  const { queries } = buildDataset();
  const categories = new Set(queries.map((q) => q.category));
  for (const c of ["paraphrase", "keyword", "correction", "context", "needle", "temporal", "no-answer"]) {
    assert.ok(categories.has(c), c);
  }
  assert.ok(queries.filter((q) => q.split === "holdout").length >= 20, "a real holdout exists");
  assert.ok(queries.filter((q) => q.answerable).length >= 90, "enough answerable queries for a usable interval");
  for (const q of queries) {
    assert.equal(q.answerable, q.gold.length > 0, q.id);
    if (q.category === "correction") assert.ok(q.newer && q.older && q.newer !== q.older, q.id);
  }
});

test("long sessions hide the key sentence among filler and every turn has a time", () => {
  const { sessions } = buildDataset();
  const long = sessions.filter((s) => s.id.startsWith("s-long-") || s.id.startsWith("g-n"));
  assert.equal(long.length, 16);
  for (const s of long) assert.ok(sessionText(s).length > 2000 && sessionText(s).length < 6000, s.id);
  for (const s of sessions) for (const t of s.turns) assert.ok(Number.isSafeInteger(t.occurredAt), s.id);
});

test("longTurns makes the long sessions exceed the excerpt budget and records where the needle is", () => {
  const BUDGET = 6000;
  const longIds = (d) => d.sessions.filter((s) => s.needleIndex !== undefined);
  const normal = buildDataset({ size: 300 });
  assert.ok(longIds(normal).length >= 10);
  assert.ok(longIds(normal).every((s) => sessionText(s).length < BUDGET), "default long sessions stay under the budget");
  const big = buildDataset({ size: 300, longTurns: 450 });
  assertNoLeakage(big);
  assert.equal(longIds(big).length, longIds(normal).length);
  for (const s of longIds(big)) {
    assert.ok(sessionText(s).length > BUDGET, `${s.id} is over the budget`);
    assert.equal(s.turns[s.needleIndex].role, "user");
    assert.equal(s.turns[s.needleIndex + 1].text, "好的，我记下了。");
  }
});

test("longTurns 0 leaves the dataset exactly as before", () => {
  const strip = (d) => d.sessions.map((s) => [s.id, s.turns.map((t) => [t.role, t.text, t.occurredAt])]);
  assert.deepEqual(strip(buildDataset({ size: 120 })), strip(buildDataset({ size: 120, longTurns: 0 })));
});

test("raising longTurns changes only the long sessions, never the other sessions or the queries", () => {
  const a = buildDataset({ size: 300 });
  const b = buildDataset({ size: 300, longTurns: 450 });
  const rest = (d) => d.sessions.filter((s) => s.needleIndex === undefined);
  assert.ok(rest(a).length > 200);
  assert.deepEqual(rest(a), rest(b));
  assert.deepEqual(a.queries, b.queries);
  assert.deepEqual(a.sessions.map((s) => s.id), b.sessions.map((s) => s.id));
});

test("a long session keeps the same needle message when it is lengthened", () => {
  const needleOf = (s) => s.turns[s.needleIndex].text;
  const a = buildDataset({ size: 300 }).sessions.filter((s) => s.needleIndex !== undefined);
  const b = buildDataset({ size: 300, longTurns: 450 }).sessions.filter((s) => s.needleIndex !== undefined);
  assert.deepEqual(b.map(needleOf), a.map(needleOf));
  for (const s of b) assert.ok(s.turns.length >= 450, `${s.id} has ${s.turns.length} turns`);
});
