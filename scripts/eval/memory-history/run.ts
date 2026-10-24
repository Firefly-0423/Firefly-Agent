// @ts-nocheck  评测脚本由 esbuild 打包运行，不参与 tsc 检查。
/**
 * H（历史检索）离线评测。直接调用生产代码：
 *   - 排序：src/main/memory-history/history-ranking.ts 的 rankHistory（BM25 + 向量 + RRF + MMR）
 *   - 向量：src/main/rag/embedding.ts 的本地 BGE-M3
 *   - 重排：src/main/rag/reranker.ts 的本地 bge-reranker-base
 * 评测的是"排序层"。授权、来源校验、预算裁剪等不在范围内。
 */
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rankHistory } from "../../../src/main/memory-history/history-ranking";
import { createLocalEmbeddingProvider } from "../../../src/main/rag/embedding";
import { createStandardReranker } from "../../../src/main/rag/reranker";
import { tokenizeJieba } from "../../../src/main/rag/jieba-tokenizer";
import { toWindows } from "../../../src/main/memory-history/history-windows";
import { selectExcerpt } from "../../../src/main/memory-history/history-excerpts";
import { DEFAULT_HISTORY_SETTINGS } from "../../../src/main/memory-history/history-contracts";
import { assertNoLeakage, buildDataset, sessionText } from "./dataset.mjs";
import { auc, bootstrapCi, dedupe, evidenceContains, hitAtK, mean, ndcgAtK, packEvidence, percentile, recallAtK, reciprocalRank, supersededOrder } from "./metrics.mjs";

const args = parseArgs(process.argv.slice(2));
const SIZES = (args.sizes ?? "250,512").split(",").map(Number);
const GRANULARITIES = (args.granularity ?? "session,window").split(",");
const SPLIT = args.split ?? "dev"; // dev | holdout | all。调参只能看 dev。
const OUT_DIR = args.out ?? path.join(process.cwd(), "output", "memory-eval");
const SEED = Number(args.seed ?? 20261013);
// 新近度加权：相关度乘 (1 + α·exp(-age·ln2/半衰期))。只在候选之间做微调，不改变候选集合。
// --units N：整段粒度下，词法按 N 轮一个窗口计分（向量仍是文档级）。这正是生产里不改存储就能做到的配置。
const UNITS = Number(args.units ?? 0);
// --long-turns N：长会话的基础轮数（默认 160，约 3000 字，低于 6000 字的摘录预算）；450 约 7500 字，能覆盖预算问题。
const LONG_TURNS = Number(args["long-turns"] ?? 0);
// --context-windows N：摘录时最佳窗口两侧各最多再扩几个窗口（证据召回对照用）。
const CONTEXT_WINDOWS = Number(args["context-windows"] ?? 1);
// 近似并列时新的优先（词法路线用）：相邻两项相关度差不超过 delta、且后者更新超过 gap 天时交换。
const NEARTIE_DELTA = Number(args["neartie-delta"] ?? 0.05);
const NEARTIE_GAP_DAYS = Number(args["neartie-gap"] ?? 7);
const RECENCY_ALPHA = Number(args["recency-alpha"] ?? 0.1);
const RECENCY_HALF_LIFE_DAYS = Number(args["recency-halflife"] ?? 30);
const ALL_MODES = ["lexical", "lexical+stop", "dense", "hybrid", "hybrid+stop", "hybrid+rerank8", "hybrid+rerank30", "lexical+rerank30", "lexical+stop+rerank30", "hybrid+rangefilter", "lexical+recency", "hybrid+recency", "hybrid+stop+recency", "hybrid+prodrecency", "lexical+neartie"];
const MODES = args.modes ? args.modes.split(",").filter((m) => ALL_MODES.includes(m)) : ALL_MODES;

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) out[list[i].slice(2)] = list[i + 1]?.startsWith("--") || list[i + 1] === undefined ? "true" : list[++i];
  }
  return out;
}


// 向量落盘缓存：同一段文本、同一个模型身份只算一次，反复做对照实验时不用重新建索引。
const CACHE_FILE = args.cache ?? path.join(process.cwd(), "output", "memory-eval", "vector-cache.json");
const textKey = (text) => crypto.createHash("sha1").update(text).digest("hex");
// Buffer.from 返回的是共享内存池里的一小段，不能直接取 .buffer；先拷贝到独立的 ArrayBuffer。
function decodeVector(base64) {
  const bytes = Buffer.from(base64, "base64");
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return Array.from(new Float32Array(copy));
}
function loadVectorCache(modelId) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (raw.model !== modelId) return new Map();
    return new Map(Object.entries(raw.vectors).map(([k, v]) => [k, decodeVector(v)]));
  } catch { return new Map(); }
}
function saveVectorCache(modelId, cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const vectors = {};
  for (const [k, v] of cache) vectors[k] = Buffer.from(new Float32Array(v).buffer).toString("base64");
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ model: modelId, vectors }));
}


const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function gitInfo() {
  try {
    const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit: run("git rev-parse HEAD"), dirty: run("git status --porcelain").length > 0 };
  } catch { return { commit: null, dirty: null }; }
}

const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
let rssPeak = rssMb();
const sample = () => { rssPeak = Math.max(rssPeak, rssMb()); };

// ── 文档构造：session 对应生产的 captureTranscript（整段会话一个文档）；window 是实验用的两轮窗口 ──
function buildDocs(dataset, granularity) {
  const docs = [];
  for (const s of dataset.sessions) {
    if (granularity === "session") {
      const times = s.turns.map((t) => t.occurredAt);
      const units = UNITS > 0 ? toWindows(s.turns, UNITS) : null;
      docs.push({ id: s.id, sessionId: s.id, text: sessionText(s), ...(units ? { units } : {}), timeSpan: { start: Math.min(...times), end: Math.max(...times) } });
    } else {
      for (let i = 0; i < s.turns.length; i += 2) {
        const part = s.turns.slice(i, i + 2);
        const times = part.map((t) => t.occurredAt);
        docs.push({ id: `${s.id}#${i / 2}`, sessionId: s.id, text: part.map((t) => t.text).join("\n"), timeSpan: { start: Math.min(...times), end: Math.max(...times) } });
      }
    }
  }
  return docs;
}

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);


// 对照用分词器：和生产分词一致，只额外丢弃停用词（好、用、什么 这类高频虚词）。
// 生产的 createHistoryTokenizer 没有使用 jieba-tokenizer 里已有的 isStop 标记。
let stopTokenizer;
function getStopTokenizer() {
  if (stopTokenizer) return stopTokenizer;
  const { Jieba } = require("@node-rs/jieba");
  const jieba = new Jieba();
  stopTokenizer = {
    version: "eval-stop-v1",
    register() {},
    tokens: (text) => tokenizeJieba(text, jieba, new Set()).filter((t) => !t.isStop && /[\p{L}\p{N}]/u.test(t.word)).map((t) => t.word),
  };
  return stopTokenizer;
}

// ── 检索方式 ──────────────────────────────────────────────────────────────────
async function runMode(mode, ctx, query) {
  const { docs, emb, reranker, vectors } = ctx;
  const byId = new Map(docs.map((d) => [d.id, d]));
  const rankDocs = (withVectors) => docs.map((d) => ({ id: d.id, text: d.text, timeSpan: d.timeSpan, ...(d.units ? { units: d.units } : {}), ...(withVectors ? { vector: vectors.get(d.id) } : {}) }));
  const temporal = query.temporal;
  const t0 = performance.now();
  let ids = [];
  let items = null; // 带窗口下标的排序结果，供证据打包用；只有直接来自 rankHistory 的方式才有
  let topScore = null;
  let note;

  const rerank = async (candidateIds, limit) => {
    const texts = candidateIds.map((id) => byId.get(id).text);
    const ranked = await reranker.rerank(query.text, texts);
    // 重排器按分数返回文本，重复文本需要按顺序取回 id。
    const buckets = new Map();
    candidateIds.forEach((id, i) => buckets.set(texts[i], [...(buckets.get(texts[i]) ?? []), id]));
    const out = ranked.map((r) => ({ id: buckets.get(r.text).shift(), score: r.score }));
    topScore = out[0]?.score ?? null;
    return out.slice(0, limit).map((r) => r.id);
  };
  const embedQuery = async () => emb.embed(query.text); // 查询向量每次现算，计入延迟

  try {
    if (mode === "lexical") {
      items = rankHistory(rankDocs(false), query.text, { limit: 8, candidateLimit: 50, ...(temporal ? { temporal } : {}) }).items;
      ids = items.map((r) => r.id);
    } else if (mode === "lexical+stop") {
      items = rankHistory(rankDocs(false), query.text, { limit: 8, candidateLimit: 50, tokenizer: getStopTokenizer(), ...(temporal ? { temporal } : {}) }).items;
      ids = items.map((r) => r.id);
    } else if (mode === "dense") {
      if (temporal) throw new Error("MEMORY_HISTORY_TEMPORAL_VECTOR_UNSUPPORTED");
      const v = await embedQuery();
      const scored = docs.map((d) => ({ id: d.id, score: dot(v, vectors.get(d.id)) })).sort((a, b) => b.score - a.score);
      topScore = scored[0].score;
      ids = scored.slice(0, 8).map((r) => r.id);
    } else if (mode === "hybrid" || mode === "hybrid+stop" || mode === "hybrid+rerank8" || mode === "hybrid+rerank30") {
      const queryVector = await embedQuery();
      const ranked = rankHistory(rankDocs(true), query.text, { limit: 8, candidateLimit: 50, queryVector, ...(mode === "hybrid+stop" ? { tokenizer: getStopTokenizer() } : {}), ...(temporal ? { temporal } : {}) });
      if (mode === "hybrid" || mode === "hybrid+stop") { items = ranked.items; ids = items.map((r) => r.id); }
      else if (mode === "hybrid+rerank8") ids = await rerank(ranked.items.map((r) => r.id), 8);
      else ids = await rerank(ranked.fused.slice(0, 30).map((r) => r.id), 8);
    } else if (mode === "lexical+rerank30" || mode === "lexical+stop+rerank30") {
      if (temporal) throw new Error("not-applicable");
      const ranked = rankHistory(rankDocs(false), query.text, { limit: 8, candidateLimit: 50, ...(mode === "lexical+stop+rerank30" ? { tokenizer: getStopTokenizer() } : {}) });
      ids = await rerank(ranked.fused.slice(0, 30).map((r) => r.id), 8);
    } else if (mode === "lexical+neartie") {
      if (temporal) throw new Error("not-applicable");
      const ranked = rankHistory(rankDocs(false), query.text, { limit: 8, candidateLimit: 50 });
      const list = ranked.routeRanks.lexical.map((r) => ({ id: r.id, score: r.score }));
      const end = (id) => byId.get(id).timeSpan.end;
      for (let pass = 0; pass < list.length; pass++) {
        let swapped = false;
        for (let i = 0; i + 1 < list.length; i++) {
          if (list[i + 1].score >= (1 - NEARTIE_DELTA) * list[i].score && end(list[i + 1].id) - end(list[i].id) > NEARTIE_GAP_DAYS * 86_400_000) {
            [list[i], list[i + 1]] = [list[i + 1], list[i]];
            swapped = true;
          }
        }
        if (!swapped) break;
      }
      ids = list.slice(0, 8).map((r) => r.id);
    } else if (mode === "hybrid+prodrecency") {
      // 生产代码里的新近度：rankHistory 的 recency 选项（在多样性去重之前作用于融合后的前 30 个候选）。
      if (temporal) throw new Error("not-applicable");
      const queryVector = await embedQuery();
      items = rankHistory(rankDocs(true), query.text, { limit: 8, candidateLimit: 50, queryVector, recency: { alpha: RECENCY_ALPHA, halfLifeDays: RECENCY_HALF_LIFE_DAYS, now: ctx.now } }).items;
      ids = items.map((r) => r.id);
    } else if (mode === "lexical+recency" || mode === "hybrid+recency" || mode === "hybrid+stop+recency") {
      if (temporal) throw new Error("not-applicable");
      const useVector = mode !== "lexical+recency";
      const queryVector = useVector ? await embedQuery() : undefined;
      const ranked = rankHistory(rankDocs(useVector), query.text, { limit: 8, candidateLimit: 50, ...(useVector ? { queryVector } : {}), ...(mode === "hybrid+stop+recency" ? { tokenizer: getStopTokenizer() } : {}) });
      const ageDays = (d) => Math.max(0, (ctx.now - byId.get(d).timeSpan.end) / 86_400_000);
      const boosted = ranked.fused.slice(0, 30).map((r) => ({ id: r.id, score: r.score * (1 + RECENCY_ALPHA * Math.exp((-Math.LN2 * ageDays(r.id)) / RECENCY_HALF_LIFE_DAYS)) }));
      boosted.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      ids = boosted.slice(0, 8).map((r) => r.id);
    } else if (mode === "hybrid+rangefilter") {
      // 模拟"范围查询 + 向量"的修复：先按时间范围过滤，再做混合排序。最新优先不在此范围。
      if (temporal?.kind === "latest") throw new Error("not-applicable");
      const queryVector = await embedQuery();
      const pool = temporal?.kind === "range" ? docs.filter((d) => d.timeSpan.start <= temporal.to && d.timeSpan.end >= temporal.from) : docs;
      const withVec = pool.map((d) => ({ id: d.id, text: d.text, timeSpan: d.timeSpan, vector: vectors.get(d.id) }));
      ids = rankHistory(withVec, query.text, { limit: 8, candidateLimit: 50, queryVector }).items.map((r) => r.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("TEMPORAL_VECTOR") && message !== "not-applicable" && !globalThis.__shownError) {
      globalThis.__shownError = true;
      console.error(`[eval] 第一个非预期错误（模式 ${mode}）：`, error instanceof Error ? error.stack : error);
    }
    return { mode, status: message === "not-applicable" ? "n/a" : message.includes("TEMPORAL_VECTOR") ? "unsupported" : "error", note: message, ids: [], topScore: null, ms: performance.now() - t0 };
  }
  sample();
  return { mode, status: "ok", ids, items, topScore, ms: performance.now() - t0, note };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const maxSize = Math.max(...SIZES);
  const full = buildDataset({ size: maxSize, seed: SEED, longTurns: LONG_TURNS });
  assertNoLeakage(full);
  const queries = full.queries.filter((q) => SPLIT === "all" || q.split === SPLIT);
  console.log(`# H 检索评测  split=${SPLIT}  sizes=${SIZES.join(",")}  queries=${queries.length}  seed=${SEED}`);

  const emb = createLocalEmbeddingProvider("bgem3");
  if (!emb) throw new Error("本地向量模型未安装（models/Xenova/bge-m3）");
  let t = performance.now();
  await emb.embed("warm up");
  const embedLoadMs = Math.round(performance.now() - t);
  t = performance.now();
  const reranker = await createStandardReranker();
  await reranker.rerank("warm up", ["a", "b"]);
  const rerankLoadMs = Math.round(performance.now() - t);
  sample();
  const rssAfterLoad = rssMb();

  const querySet = (split) => full.queries.filter((q) => q.split === split).map((q) => ({ id: q.id, category: q.category, text: q.text, gold: q.gold, newer: q.newer, older: q.older, temporal: q.temporal }));
  const result = { meta: { label: args.label ?? null, units: UNITS, longTurns: LONG_TURNS, contextWindows: CONTEXT_WINDOWS, evidenceBudget: { maxExcerptChars: DEFAULT_HISTORY_SETTINGS.maxExcerptChars, maxTotalChars: DEFAULT_HISTORY_SETTINGS.maxTotalChars }, args, git: gitInfo(), models: { embedding: emb.name, embeddingDims: emb.dims, embeddingIdentity: emb.cacheIdentity ?? null, reranker: reranker.name }, modes: MODES, granularities: GRANULARITIES,
    datasetDigest: digest({ seed: SEED, size: maxSize, sessions: full.sessions.map((s) => [s.id, s.turns.map((t) => [t.role, t.text, t.occurredAt])]) }),
    querySetDigests: { dev: digest(querySet("dev")), holdout: digest(querySet("holdout")) },
    recencyAlpha: RECENCY_ALPHA, recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS, split: SPLIT, sizes: SIZES, seed: SEED, queries: queries.length, node: process.version, platform: process.platform, embedLoadMs, rerankLoadMs, rssAfterLoadMb: rssAfterLoad }, runs: [], index: [] };
  const modelId = emb.name + ":" + (emb.dims ?? "");
  const textCache = loadVectorCache(modelId);
  const cachedBefore = textCache.size;
  const vectorCache = new Map(); // docId -> vector，按文本内容从 textCache 取

  for (const granularity of GRANULARITIES) {
    const maxDocs = buildDocs(full, granularity);
    t = performance.now();
    let embedded = 0;
    for (const d of maxDocs) {
      if (vectorCache.has(d.id)) continue;
      const key = textKey(d.text);
      let v = textCache.get(key);
      if (!v) { v = await emb.embed(d.text); textCache.set(key, v); embedded++; }
      vectorCache.set(d.id, v);
    }
    if (embedded) saveVectorCache(modelId, textCache);
    sample();
    result.index.push({ granularity, docs: maxDocs.length, embedded, ms: Math.round(performance.now() - t), msPerDoc: embedded ? +((performance.now() - t) / embedded).toFixed(1) : 0 });

    for (const size of SIZES) {
      const dataset = buildDataset({ size, seed: SEED, longTurns: LONG_TURNS });
      const docs = buildDocs(dataset, granularity);
      const ctx = { docs, emb, reranker, vectors: vectorCache, now: dataset.now };
      const sessionTime = new Map(dataset.sessions.map((s) => [s.id, { start: Math.min(...s.turns.map((x) => x.occurredAt)), end: Math.max(...s.turns.map((x) => x.occurredAt)) }]));
      const sessionOf = new Map(docs.map((d) => [d.id, d.sessionId]));
      const sessionById = new Map(dataset.sessions.map((s) => [s.id, s]));
      const sizesOf = (id) => sessionById.get(id).turns.map((t) => t.text.length);

      // 先热身一遍，避免首次调用拉高延迟
      for (const mode of MODES) await runMode(mode, ctx, queries[0]);

      const rows = [];
      for (const query of queries) {
        for (const mode of MODES) {
          const run = await runMode(mode, ctx, query);
          const ranked = dedupe(run.ids.map((id) => sessionOf.get(id)));
          const row = { query: query.id, category: query.category, mode, status: run.status, ranked, ms: run.ms, topScore: run.topScore };
          if (run.status === "ok" && query.answerable) {
            row.hit1 = hitAtK(ranked, query.gold, 1);
            row.hit3 = hitAtK(ranked, query.gold, 3);
            row.hit5 = hitAtK(ranked, query.gold, 5);
            row.recall8 = recallAtK(ranked, query.gold, 8);
            row.rr = reciprocalRank(ranked, query.gold);
            row.ndcg8 = ndcgAtK(ranked, query.gold, 8);
            if (query.newer) row.order = supersededOrder(ranked, query.newer, query.older);
            if (query.temporal?.kind === "range") {
              const top = ranked.slice(0, 3);
              row.leak3 = top.length ? top.filter((id) => { const s = sessionTime.get(id); return !(s.start <= query.temporal.to && s.end >= query.temporal.from); }).length / top.length : 0;
            }
          }
          // 证据召回：关键句（needle）有没有真的送达模型。整段粒度才有"一份文档 = 一个会话"，才能按预算打包。
          if (run.status === "ok" && run.items && granularity === "session" && query.category === "needle") {
            const needleIndex = sessionById.get(query.gold[0])?.needleIndex;
            if (needleIndex !== undefined) {
              const pack = (policy) => packEvidence({ items: run.items, sizesOf, policy, select: selectExcerpt, maxExcerptChars: DEFAULT_HISTORY_SETTINGS.maxExcerptChars, maxTotalChars: DEFAULT_HISTORY_SETTINGS.maxTotalChars, windowTurns: UNITS, contextWindows: CONTEXT_WINDOWS });
              const whole = pack("whole");
              const excerpt = pack("excerpt");
              row.evidence = { whole: evidenceContains(whole, query.gold[0], needleIndex), excerpt: evidenceContains(excerpt, query.gold[0], needleIndex), wholeChars: whole.reduce((n, p) => n + p.chars, 0), excerptChars: excerpt.reduce((n, p) => n + p.chars, 0) };
            }
          }
          rows.push(row);
        }
      }
      result.runs.push({ granularity, size, docs: docs.length, rows });
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, args.label ? `${args.label}.json` : `${stamp}-${SPLIT}.json`);
  result.meta.rssPeakMb = rssPeak;
  result.queries = queries;
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  report(result, queries);
  console.log(`\n完整结果：${file}`);
}

// ── 报告 ──────────────────────────────────────────────────────────────────────
const f = (x, d = 2) => (x === null || x === undefined ? "–" : x.toFixed(d));
const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

function report(result, queries) {
  const answerable = queries.filter((q) => q.answerable).length;
  const none = queries.length - answerable;
  for (const run of result.runs) {
    console.log(`\n## 粒度=${run.granularity}  规模=${run.size} 个会话（${run.docs} 个检索单元）  有答案查询 ${answerable}，无答案 ${none}`);
    console.log("\n| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const mode of MODES) {
      const rows = run.rows.filter((r) => r.mode === mode);
      const ok = rows.filter((r) => r.status === "ok" && r.hit1 !== undefined);
      const answerableRows = rows.filter((r) => queries.find((q) => q.id === r.query).answerable);
      const failed = answerableRows.filter((r) => r.status === "unsupported" || r.status === "error").length;
      // 不支持的查询按"未命中"计入分母，避免只在容易的查询上比较。
      const denom = answerableRows.filter((r) => r.status !== "n/a");
      const h1 = denom.map((r) => r.hit1 ?? 0);
      const ci = bootstrapCi(h1);
      const order = ok.filter((r) => r.order !== undefined).map((r) => r.order);
      console.log(`| ${mode} | ${pct(ci.mean)} [${pct(ci.low)}–${pct(ci.high)}] | ${pct(mean(denom.map((r) => r.hit5 ?? 0)))} | ${f(mean(denom.map((r) => r.rr ?? 0)))} | ${f(mean(denom.map((r) => r.ndcg8 ?? 0)))} | ${order.length ? pct(mean(order)) : "–"} | ${Math.round(percentile(ok.map((r) => r.ms), 0.5))} | ${Math.round(percentile(ok.map((r) => r.ms), 0.95))} | ${failed || ""} |`);
    }
    console.log("\n按类别 Hit@1：");
    const cats = [...new Set(queries.filter((q) => q.answerable).map((q) => q.category))];
    console.log(`\n| 方式 | ${cats.join(" | ")} |`);
    console.log(`|---|${cats.map(() => "---").join("|")}|`);
    for (const mode of MODES) {
      const cells = cats.map((c) => {
        const rows = run.rows.filter((r) => r.mode === mode && r.category === c && r.status !== "n/a");
        return rows.length ? pct(mean(rows.map((r) => r.hit1 ?? 0))) : "–";
      });
      console.log(`| ${mode} | ${cells.join(" | ")} |`);
    }
    const evid = MODES.map((mode) => [mode, run.rows.filter((r) => r.mode === mode && r.evidence)]).filter(([, r]) => r.length);
    if (evid.length) {
      console.log("\n证据召回（长会话里的关键句有没有真的送达；整份返回遇到超预算的会话会丢弃，摘录是只对单份就超过上限的会话改为最佳窗口加上下文）：");
      console.log("\n| 方式 | 题数 | 整份或丢弃 | 摘录（仅超长） | 整份 平均字数 | 摘录 平均字数 |");
      console.log("|---|---|---|---|---|---|");
      for (const [mode, rs] of evid) console.log(`| ${mode} | ${rs.length} | ${pct(mean(rs.map((r) => r.evidence.whole)))} | ${pct(mean(rs.map((r) => r.evidence.excerpt)))} | ${Math.round(mean(rs.map((r) => r.evidence.wholeChars)))} | ${Math.round(mean(rs.map((r) => r.evidence.excerptChars)))} |`);
    }
    const leaks = MODES.map((mode) => [mode, run.rows.filter((r) => r.mode === mode && r.leak3 !== undefined)]).filter(([, r]) => r.length);
    if (leaks.length) console.log("\n时间范围泄漏（前 3 名里落在窗口外的比例，越低越好）：" + leaks.map(([m, r]) => `${m} ${pct(mean(r.map((x) => x.leak3)))}`).join("；"));

    console.log("\n弃答可分性 AUC（用最高分区分\"有答案\"与\"无答案\"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：");
    for (const mode of ["dense", "hybrid+rerank8", "hybrid+rerank30", "lexical+rerank30", "lexical+stop+rerank30"]) {
      const pos = run.rows.filter((r) => r.mode === mode && r.status === "ok" && r.topScore !== null && queries.find((q) => q.id === r.query).answerable && !queries.find((q) => q.id === r.query).temporal).map((r) => r.topScore);
      const neg = run.rows.filter((r) => r.mode === mode && r.status === "ok" && r.topScore !== null && !queries.find((q) => q.id === r.query).answerable).map((r) => r.topScore);
      console.log(`- ${mode}: ${f(auc(pos, neg))}`);
    }
  }
  console.log("\n## 索引与资源");
  console.log("\n| 粒度 | 检索单元数 | 本次新算向量 | 耗时 ms | 每个 ms |");
  console.log("|---|---|---|---|---|");
  for (const i of result.index) console.log(`| ${i.granularity} | ${i.docs} | ${i.embedded} | ${i.ms} | ${i.msPerDoc} |`);
  const m = result.meta;
  console.log(`\n模型加载：向量 ${m.embedLoadMs} ms，重排器 ${m.rerankLoadMs} ms；加载后 RSS ${m.rssAfterLoadMb} MB，运行中峰值 RSS ${m.rssPeakMb} MB。`);
  console.log("注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。");
}

main().catch((error) => { console.error(error); process.exit(1); });
