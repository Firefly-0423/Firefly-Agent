import assert from "node:assert/strict";
import test from "node:test";
import {
  auc,
  bootstrapCi,
  dedupe,
  hitAtK,
  mean,
  mulberry32,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank,
  supersededOrder,
} from "./metrics.mjs";

test("dedupe keeps the first occurrence only", () => {
  assert.deepEqual(dedupe(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
});

test("hit, recall and reciprocal rank follow the ranked order", () => {
  const ranked = ["x", "g1", "y", "g2"];
  assert.equal(hitAtK(ranked, ["g1"], 1), 0);
  assert.equal(hitAtK(ranked, ["g1"], 2), 1);
  assert.equal(recallAtK(ranked, ["g1", "g2"], 2), 0.5);
  assert.equal(recallAtK(ranked, ["g1", "g2"], 4), 1);
  assert.equal(recallAtK(ranked, [], 4), 0);
  assert.equal(reciprocalRank(ranked, ["g2", "g1"]), 0.5);
  assert.equal(reciprocalRank(ranked, ["missing"]), 0);
});

test("nDCG is 1 for a perfect ranking and lower when the answer is pushed down", () => {
  assert.equal(ndcgAtK(["g", "a", "b"], ["g"], 3), 1);
  const lower = ndcgAtK(["a", "b", "g"], ["g"], 3);
  assert.ok(lower > 0 && lower < 1);
  assert.equal(ndcgAtK(["a", "b"], ["g"], 2), 0);
});

test("a correction must outrank the fact it supersedes", () => {
  assert.equal(supersededOrder(["new", "old"], "new", "old"), 1);
  assert.equal(supersededOrder(["old", "new"], "new", "old"), 0);
  assert.equal(supersededOrder(["new"], "new", "old"), 1);
  assert.equal(supersededOrder(["old"], "new", "old"), 0);
  assert.equal(supersededOrder([], "new", "old"), 0);
});

test("percentile and mean on small samples", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
});

test("auc is 1 for separable scores, 0.5 for ties and null without both groups", () => {
  assert.equal(auc([0.9, 0.8], [0.1, 0.2]), 1);
  assert.equal(auc([0.5], [0.5]), 0.5);
  assert.equal(auc([0.1], [0.9]), 0);
  assert.equal(auc([], [1]), null);
});

test("the seeded generator and bootstrap are reproducible", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const first = bootstrapCi([1, 0, 1, 1, 0, 1, 1, 1], { seed: 3 });
  const second = bootstrapCi([1, 0, 1, 1, 0, 1, 1, 1], { seed: 3 });
  assert.deepEqual(first, second);
  assert.ok(first.low <= first.mean && first.mean <= first.high);
  assert.deepEqual(bootstrapCi([]), { mean: 0, low: 0, high: 0 });
});

// ── 证据打包：复刻仓库的摘录预算循环，看关键句有没有真的送达 ──
import { evidenceContains, packEvidence } from "./metrics.mjs";

const fakeSelect = ({ sizes, bestUnit, windowTurns }) => {
  const start = bestUnit * windowTurns;
  return { start, end: Math.min(sizes.length, start + windowTurns) };
};
const pack = (items, sizes, policy, extra = {}) =>
  packEvidence({ items, sizesOf: (id) => sizes[id], policy, select: fakeSelect, maxExcerptChars: 100, maxTotalChars: 250, windowTurns: 2, contextWindows: 0, ...extra });

test("a document that fits is delivered whole under both policies", () => {
  const sizes = { a: Array(5).fill(10) };
  for (const policy of ["whole", "excerpt"]) {
    assert.deepEqual(pack([{ id: "a", unit: 0 }], sizes, policy), [{ id: "a", start: 0, end: 5, chars: 50 }]);
  }
});

test("an oversized document is dropped under 'whole' and cut to its best window under 'excerpt'", () => {
  const sizes = { big: Array(30).fill(10) };
  assert.deepEqual(pack([{ id: "big", unit: 4 }], sizes, "whole"), []);
  assert.deepEqual(pack([{ id: "big", unit: 4 }], sizes, "excerpt"), [{ id: "big", start: 8, end: 10, chars: 20 }]);
});

test("without a best window an oversized document stays dropped", () => {
  assert.deepEqual(pack([{ id: "big" }], { big: Array(30).fill(10) }, "excerpt"), []);
});

test("the running total budget skips later documents, as the repository does", () => {
  const sizes = { a: Array(9).fill(10), b: Array(9).fill(10), c: Array(9).fill(10), d: Array(5).fill(10) };
  const items = ["a", "b", "c", "d"].map((id) => ({ id, unit: 0 }));
  // 90 + 90 = 180；第三份会到 270 > 250，被跳过；第四份 50 仍放得下。
  assert.deepEqual(pack(items, sizes, "whole").map((p) => p.id), ["a", "b", "d"]);
});

test("an excerpt is limited by what is left of the total budget", () => {
  const sizes = { a: Array(9).fill(10), b: Array(9).fill(10), big: Array(30).fill(10) };
  const items = [{ id: "a", unit: 0 }, { id: "b", unit: 0 }, { id: "big", unit: 3 }];
  const packed = pack(items, sizes, "excerpt", { select: ({ maxChars, ...rest }) => (maxChars >= 20 ? fakeSelect(rest) : null) });
  assert.deepEqual(packed.map((p) => p.id), ["a", "b", "big"]);
  assert.equal(packed.reduce((n, p) => n + p.chars, 0), 90 + 90 + 20);
  const tight = pack(items, sizes, "excerpt", { maxTotalChars: 190, select: ({ maxChars, ...rest }) => (maxChars >= 20 ? fakeSelect(rest) : null) });
  assert.deepEqual(tight.map((p) => p.id), ["a", "b"]);
});

test("evidenceContains tells whether the needle message was actually delivered", () => {
  const packed = [{ id: "x", start: 8, end: 10, chars: 20 }];
  assert.equal(evidenceContains(packed, "x", 9), 1);
  assert.equal(evidenceContains(packed, "x", 10), 0);
  assert.equal(evidenceContains(packed, "other", 9), 0);
  assert.equal(evidenceContains([], "x", 9), 0);
});

test("under 'excerpt' a document within the single-document limit but over the remaining total is skipped, not cut", () => {
  const sizes = { a: Array(9).fill(10), b: Array(9).fill(10), c: Array(9).fill(10) };
  const items = ["a", "b", "c"].map((id) => ({ id, unit: 0 }));
  // c 单份 90 ≤ 100，但累计会到 270 > 250：口径是"只摘录单份超限的会话"，所以直接跳过。
  assert.deepEqual(pack(items, sizes, "excerpt").map((p) => p.id), ["a", "b"]);
});
