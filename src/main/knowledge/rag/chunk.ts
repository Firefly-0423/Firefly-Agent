// 文档分块：按估算 token 数滑动切窗，窗口末端尽量对齐句末，
// 并为每块附上所在 Markdown 标题链。

export interface Chunk {
  /** `${source}_${index}` */
  id: string;
  /** 来自哪个文档（或 "memory"） */
  source: string;
  /** 该文档内从 0 开始的序号 */
  index: number;
  text: string;
  metadata?: Record<string, unknown>;
}

// 窗口与重叠都按估算 token 计
export const DOCUMENT_CHUNK_SIZE = 512;
export const DOCUMENT_CHUNK_OVERLAP = 128;

const CJK_RE = /[一-鿿]/g;
const SENTENCE_END = "。！？\n.!?";

/** 粗估 token：每个汉字一个，其余按空白分词计数。 */
function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const words = text.replace(CJK_RE, " ").split(/\s+/).filter(Boolean).length;
  return cjk + words;
}

interface Span {
  start: number;
  end: number;
  text: string;
}

/** 自 from 起向后找句末标点，返回连续标点之后的下标；没有则 -1。 */
function sentenceEndAfter(text: string, from: number): number {
  let i = from;
  while (i < text.length && !SENTENCE_END.includes(text[i])) i++;
  if (i >= text.length) return -1;
  do {
    i++;
  } while (i < text.length && SENTENCE_END.includes(text[i]));
  return i;
}

function slideWindow(text: string, chunkSize: number, overlap: number): Span[] {
  if (!text || !text.trim()) return [];

  const length = text.length;
  const total = estimateTokens(text);
  if (total <= chunkSize) return [{ start: 0, end: length, text }];

  const density = total / length; // token / 字符
  const stride = (chunkSize - overlap) / density; // 每步前进的字符数
  const tailLimit = chunkSize * density * 0.33;
  const spans: Span[] = [];

  let cursor = 0;
  while (cursor < length) {
    const last = spans[spans.length - 1];
    if (last && length - cursor < tailLimit) {
      // 剩余太短，并入上一块
      last.end = length;
      last.text = text.slice(last.start);
      break;
    }

    const from = Math.round(cursor);
    let to = Math.min(length, Math.round((Math.round(cursor * density) + chunkSize) / density));

    const reach = to + Math.round(chunkSize * 0.2 * density);
    const edge = sentenceEndAfter(text, to);
    if (edge !== -1 && edge <= Math.min(reach, length)) to = edge;

    spans.push({ start: from, end: to, text: text.slice(from, to) });
    cursor += stride;
  }

  return spans;
}

interface Heading {
  level: number;
  title: string;
  tokenPos: number;
}

function collectHeadings(text: string): Heading[] {
  const found: Heading[] = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) found.push({ level: m[1].length, title: m[2].trim(), tokenPos: pos });
    pos += estimateTokens(line + "\n");
  }
  return found;
}

/** 生成某 token 位置处的标题链，形如 "A > B"。 */
function headingTrail(pos: number, headings: Heading[]): string {
  const trail: Heading[] = [];
  for (const h of headings) {
    if (h.tokenPos > pos) break;
    while (trail.length && trail[trail.length - 1].level >= h.level) trail.pop();
    trail.push(h);
  }
  return trail.map((h) => h.title).join(" > ");
}

export function chunkText(text: string, source: string, chunkSize = DOCUMENT_CHUNK_SIZE, overlap = DOCUMENT_CHUNK_OVERLAP): Chunk[] {
  return [...iterateDocumentChunks(text, source, chunkSize, overlap)];
}

export function* iterateDocumentChunks(
  text: string, source: string, chunkSize = DOCUMENT_CHUNK_SIZE, overlap = DOCUMENT_CHUNK_OVERLAP,
): Generator<Chunk> {
  const headings = collectHeadings(text);
  let index = 0;

  for (const span of slideWindow(text, chunkSize, overlap)) {
    let body = span.text.trim();
    if (!body) continue;

    if (headings.length > 0) {
      const trail = headingTrail(estimateTokens(text.slice(0, span.start)), headings);
      if (trail) body = `【${trail}】${body}`;
    }

    yield { id: `${source}_${index}`, text: body, source, index };
    index++;
  }
}
