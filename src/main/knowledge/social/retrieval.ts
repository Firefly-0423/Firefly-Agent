import { Jieba } from "@node-rs/jieba";
import type { SocialAtom } from "./types";

const tokenizer = new Jieba();
function termsOf(source: string): string[] {
  const normalized = source.trim().toLowerCase();
  if (!normalized) return [];
  try {
    return tokenizer.cut(normalized, true).map((word) => word.trim())
      .filter((word) => word.length > 0 && !/^\s+$/.test(word));
  } catch {
    return normalized.match(/[一-鿿]|[a-z0-9]+/g) ?? [];
  }
}

function frequencies(words: readonly string[]): Map<string, number> {
  const histogram = new Map<string, number>();
  for (const word of words) histogram.set(word, (histogram.get(word) ?? 0) + 1);
  return histogram;
}

function relevance(query: string, candidates: readonly SocialAtom[]): number[] {
  const sought = [...new Set(termsOf(query))];
  const corpus = candidates.map((fact) => termsOf(fact.content));
  if (sought.length === 0 || corpus.length === 0) return candidates.map(() => 0);
  const tokenCount = corpus.reduce((size, words) => size + words.length, 0);
  const meanLength = (tokenCount / corpus.length) || 1;
  const containing = new Map<string, number>();
  for (const words of corpus) {
    for (const word of new Set(words)) containing.set(word, (containing.get(word) ?? 0) + 1);
  }
  return corpus.map((words) => {
    const histogram = frequencies(words);
    let sum = 0;
    for (const word of sought) {
      const occurrences = histogram.get(word) ?? 0;
      if (occurrences === 0) continue;
      const documents = containing.get(word) ?? 0;
      const inverse = Math.log(1 + (corpus.length - documents + 0.5) / (documents + 0.5));
      const denominator = occurrences + 1.2 * (0.25 + 0.75 * words.length / meanLength);
      sum += inverse * occurrences * 2.2 / denominator;
    }
    return sum;
  });
}

export function rankSocialAtoms(query: string, atoms: readonly SocialAtom[], options: { now?: number; limit?: number } = {}): SocialAtom[] {
  const instant = options.now ?? Date.now();
  const count = Math.max(0, options.limit ?? 5);
  const eligible = atoms.filter((fact) => fact.status === "active"
    && (typeof fact.expiresAt !== "number" || fact.expiresAt > instant));
  const matches = relevance(query, eligible);
  const weighted = eligible.map((fact, position) => {
    const minimum = fact.type === "open_loop" ? 0.05 : 0;
    const elapsedDays = Math.max(0, instant - fact.createdAt) / 86_400_000;
    const decay = Math.pow(0.5, elapsedDays / 30);
    return { fact, weight: Math.max(matches[position], minimum) * decay };
  });
  return weighted.filter((match) => match.weight > 0)
    .sort((left, right) => right.weight - left.weight).slice(0, count).map((match) => match.fact);
}
