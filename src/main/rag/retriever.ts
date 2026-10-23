import { JsonVectorStore, SearchResult } from "./vectorstore";
import { EmbeddingProvider, getEmbeddingProvider } from "./embedding";
import { getReranker } from "./reranker";

// 分词用 @node-rs/jieba（兼容 Node 24，nodejieba 已弃用）
import { tokenizeJieba, type TokenInfo } from "./jieba-tokenizer";
import { Jieba } from "@node-rs/jieba";

const jieba = new Jieba();
const STOP_WEIGHT = 0.3;
const NOUN_WEIGHT = 1.3;

export interface RetrieveOptions {
  importIds?: string[];
  allowedEntryIds?: string[];
}

// ───────────── 自定义词表 ─────────────
// 该 jieba 绑定没有运行时 insertWord，所以切词后再把属于自定义词的相邻 token 合并回去。
const customWords = new Set<string>();
// 词表真正新增词时版本号加一，用来让已缓存的文档分词失效
let customWordsVersion = 0;

function addCustomWord(word: string): void {
  if (word.length >= 2 && !customWords.has(word)) customWordsVersion++;
  customWords.add(word);
}

/** 注册一个自定义词，分词时不再被切散。 */
export function registerJiebaCustomWord(word: string): void {
  addCustomWord(word);
}

/** 批量注册自定义词。 */
export function registerJiebaCustomWords(words: Iterable<string>): void {
  for (const word of words) addCustomWord(word);
}

const tokenize = (text: string): TokenInfo[] => tokenizeJieba(text, jieba, customWords);

// ───────────── BM25 分词缓存 ─────────────
// 条目文本写入后不会再变，分词结果直接挂在条目对象上，条目被回收时缓存随之消失。
// 全库分词是 BM25 的主要开销（3000 个 chunk 约 2.5 秒），缓存后只需在首次检索时付一次；
// 自定义词表变化会改变分词结果，因此按版本号判断是否重算。
const docTokenCache = new WeakMap<object, { version: number; tokens: TokenInfo[] }>();

function getDocTokens(entry: object & { text: string }): TokenInfo[] {
  const hit = docTokenCache.get(entry);
  if (hit?.version === customWordsVersion) return hit.tokens;
  const tokens = tokenize(entry.text);
  docTokenCache.set(entry, { version: customWordsVersion, tokens });
  return tokens;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function bm25Score(queryTokens: TokenInfo[], docTokens: TokenInfo[], docFreq: Map<string, number>, totalDocs: number, avgDocLen: number): number {
  const termCounts = new Map<string, number>();
  docTokens.forEach((t) => termCounts.set(t.word, (termCounts.get(t.word) || 0) + 1));
  const lengthNorm = 1 - BM25_B + BM25_B * (avgDocLen ? docTokens.length / avgDocLen : 1);

  let total = 0;
  for (const q of queryTokens) {
    const df = docFreq.get(q.word) || 0;
    if (df === 0) continue;

    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const tf = termCounts.get(q.word) || 0;
    let part = idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm));

    if (q.isNoun) part *= NOUN_WEIGHT; // 名词是主要信息载体，加权
    if (q.isStop) part *= STOP_WEIGHT; // 停用词高频无意义，降权

    total += part;
  }
  return total;
}

type RawEntry = {
  id: string; text: string; embedding: number[]; source: string;
  weight: number; createdAt: number; lastRecalledAt: number; metadata?: Record<string, unknown>;
};

// ───────────── 混合检索器 ─────────────

export class HybridRetriever {
  private provider: EmbeddingProvider | null;
  private store: JsonVectorStore;

  constructor(store: JsonVectorStore, provider?: EmbeddingProvider | null) {
    this.provider = provider ?? null;
    this.store = store;
  }

  async retrieve(
    query: string, source?: string, topK = 5, options: RetrieveOptions = {},
    vectorWeight = 0.7, bm25Weight = 0.3,
  ): Promise<SearchResult[]> {
    if (this.store.stats.total === 0) return [];

    // 没有 provider 时向量检索不可用，只走 BM25
    if (!this.provider) return this.bm25Search(query, source, topK, options);

    const vectorHits = await this.store.search(query, source, this.provider, topK * 3, 0.3, options);
    const keywordHits = this.bm25Search(query, source, topK * 3, options);

    // 按条目 id 合并两路分数
    const byId = new Map<string, { result: SearchResult; vectorScore: number; bm25Score: number }>();
    for (const hit of vectorHits) {
      byId.set(hit.entry.id, { result: hit, vectorScore: hit.score, bm25Score: 0 });
    }
    for (const hit of keywordHits) {
      const slot = byId.get(hit.entry.id);
      if (slot) slot.bm25Score = hit.score;
      else byId.set(hit.entry.id, { result: hit, vectorScore: 0, bm25Score: hit.score });
    }

    // 各自除以最大值（下限 1）后加权求和
    const rows = [...byId.values()];
    const maxVector = Math.max(...rows.map((r) => r.vectorScore), 1);
    const maxKeyword = Math.max(...rows.map((r) => r.bm25Score), 1);

    const ranked = rows
      .map((r) => ({
        ...r.result,
        score: (r.vectorScore / maxVector) * vectorWeight + (r.bm25Score / maxKeyword) * bm25Weight,
      }))
      .sort((a, b) => b.score - a.score);
    const candidates = ranked.slice(0, topK);

    // 有 reranker 时用 cross-encoder 对候选精排
    const reranker = getReranker();
    if (reranker && candidates.length > 1) {
      try {
        const reranked = await reranker.rerank(query, candidates.map((c) => c.entry.text));
        const rerankByText = new Map(reranked.map((r) => [r.text, r.score]));

        for (const candidate of candidates) {
          const replacement = rerankByText.get(candidate.entry.text);
          if (replacement !== undefined) candidate.score = replacement;
        }
        candidates.sort((a, b) => b.score - a.score);
      } catch (err) {
        console.warn("[HybridRetriever] reranker failed, using hybrid scores:", err);
      }
    }
    return candidates;
  }

  /**
   * 后台预热 BM25 分词缓存，把"首次检索才付全库分词成本"提前到导入完成时。
   * 每片 50 条，片间用 setImmediate 让出事件循环，单片只占毫秒级。
   * 失败静默：预热只是提前填缓存，检索路径自己总能补算。
   * 返回的 Promise 供需要等待预热的调用方（如基准测试）使用，生产路径可以不等。
   */
  warmupBm25Tokens(entries: Array<{ text: string }>): Promise<void> {
    const SLICE = 50;
    return new Promise((resolve) => {
      const total = entries.length;
      if (total === 0) {
        resolve();
        return;
      }
      const runSlice = (from: number): void => {
        try {
          const to = Math.min(from + SLICE, total);
          for (let i = from; i < to; i++) getDocTokens(entries[i]);
        } catch (err) {
          console.warn("[HybridRetriever] BM25 warmup failed:", err);
          resolve();
          return;
        }
        const next = from + SLICE;
        if (next < total) setImmediate(() => runSlice(next));
        else resolve();
      };
      setImmediate(() => runSlice(0));
    });
  }

  private bm25Search(query: string, source?: string, topK = 15, options: RetrieveOptions = {}): SearchResult[] {
    const all = this.store["entries"] as RawEntry[];

    const importFilter = new Set(options.importIds ?? []);
    const idFilter = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    const pool = source ? all.filter((e) => e.source === source) : all;
    const docs = pool.filter(
      (e) =>
        (!importFilter.size || importFilter.has(String(e.metadata?.importId ?? ""))) &&
        (!idFilter || idFilter.has(e.id)),
    );
    if (docs.length === 0) return [];

    const queryTokens = tokenize(query);
    const queryWords = new Set(queryTokens.map((t) => t.word));
    const tokenLists = docs.map((d) => getDocTokens(d));
    const avgDocLen = tokenLists.reduce((sum, t) => sum + t.length, 0) / docs.length;

    // 每个词出现在多少篇文档里
    const docFreq = new Map<string, number>();
    for (const tokens of tokenLists) {
      for (const word of new Set(tokens.map((t) => t.word))) {
        docFreq.set(word, (docFreq.get(word) || 0) + 1);
      }
    }

    const scored = docs.map((doc, i) => {
      const { id, text, embedding, source: origin, weight, createdAt, lastRecalledAt, metadata } = doc;
      const entry = { id, text, embedding, source: origin, weight, createdAt, lastRecalledAt, metadata };
      // 文档没有命中任何查询词则记 0 分
      const hitsQuery = tokenLists[i].some((t) => queryWords.has(t.word));
      const score = hitsQuery ? bm25Score(queryTokens, tokenLists[i], docFreq, docs.length, avgDocLen) : 0;
      return { entry, score };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
