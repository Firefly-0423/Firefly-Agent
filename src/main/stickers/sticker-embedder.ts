import type { EmbeddingProvider } from "../rag/embedding";
export type StickerEmbeddingEntry = { embedding: number[]; id: string };

function similarity(left: number[], right: number[]): number {
  let product = 0, leftSquared = 0, rightSquared = 0;
  left.forEach((component, position) => {
    product += component * right[position];
    leftSquared += component * component;
    rightSquared += right[position] * right[position];
  });
  if (leftSquared === 0 || rightSquared === 0) return 0;
  return product / (Math.sqrt(leftSquared) * Math.sqrt(rightSquared));
}
export async function buildStickerEmbeddingIndex(
  provider: EmbeddingProvider, builtIn: Record<string, { phrases: string[] }>,
  userStickers: Record<string, { phrases: string[] }>,
): Promise<StickerEmbeddingEntry[]> {
  const rows: Array<[string, string]> = [];
  for (const [key, description] of Object.entries(builtIn)) {
    if (Object.prototype.hasOwnProperty.call(userStickers, key)) continue;
    rows.push([key, description.phrases.join("，")]);
  }
  for (const [key, description] of Object.entries(userStickers)) rows.push([key, description.phrases.join("，")]);
  if (rows.length === 0) return [];
  const vectors = await provider.embedBatch(rows.map((row) => row[1]));
  return rows.map(([key], position) => ({ id: key, embedding: vectors[position] }));
}
export async function matchSticker(
  query: string, provider: EmbeddingProvider, index: StickerEmbeddingEntry[], threshold: number,
): Promise<{ id: string; score: number } | null> {
  if (index.length === 0) return null;
  const vector = await provider.embed(query);
  let winner: string | null = null, highest = -1;
  for (const item of index) {
    const candidate = similarity(vector, item.embedding);
    if (candidate > highest) { highest = candidate; winner = item.id; }
  }
  return winner === null || highest < threshold ? null : { id: winner, score: highest };
}
