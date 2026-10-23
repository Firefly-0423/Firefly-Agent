import { createHash } from "crypto";

export interface MarkdownHeading {
  path: string[];
  headingText: string;
  text: string;
  level: number;
  depth: number;
  endOffset: number;
  startOffset: number;
}

export interface SectionLocateError {
  kind: "NOT_FOUND" | "AMBIGUOUS";
  matches?: Array<{ path: string[] }>;
}

const ATX_HEADING = /^(#{1,6})\s+(.+)$/;

/** 文本内容的 SHA-256 摘要（十六进制），用于乐观并发校验。 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 逐行扫描 ATX 标题，记录每个标题的层级路径与字符偏移（偏移按每行长度加一个换行符累计）。 */
export function extractHeadings(content: string): MarkdownHeading[] {
  const found: MarkdownHeading[] = [];
  const ancestry: Array<{ level: number; text: string }> = [];
  let cursor = 0;
  for (const line of content.split("\n")) {
    const hit = ATX_HEADING.exec(line);
    if (hit) {
      const level = hit[1].length;
      const text = hit[2].trim();
      while (ancestry.length > 0 && ancestry[ancestry.length - 1].level >= level) {
        ancestry.pop();
      }
      ancestry.push({ level, text });
      found.push({
        level,
        depth: level,
        text,
        headingText: text,
        path: ancestry.map((node) => node.text),
        startOffset: cursor,
        endOffset: cursor + line.length,
      });
    }
    cursor += line.length + 1;
  }
  return found;
}

/** 按完整标题路径定位章节：无匹配为 NOT_FOUND，多于一个为 AMBIGUOUS，否则返回匹配的标题列表。 */
function locateHeadingPath(headings: MarkdownHeading[], headingPath: string[]): MarkdownHeading[] | SectionLocateError {
  const hits = headings.filter(
    (heading) =>
      heading.path.length === headingPath.length
      && headingPath.every((segment, index) => heading.path[index] === segment),
  );
  if (hits.length === 0) {
    return { kind: "NOT_FOUND" };
  }
  if (hits.length > 1) {
    return { kind: "AMBIGUOUS", matches: hits.map((heading) => ({ path: heading.path })) };
  }
  return hits;
}

/**
 * 计算章节结束位置。includeChildren 为 true 时，遇到层级不深于起始标题的标题才结束；
 * 否则遇到下一个标题就结束。都没有遇到时结束于文档末尾。
 * 标题定位与结束位置计算共用同一次抽取，确保 startIndex 对应当前 headings。
 */
function sectionEnd(content: string, headings: MarkdownHeading[], startIndex: number, includeChildren: boolean): number {
  const anchor = headings[startIndex];
  for (let probe = startIndex + 1; probe < headings.length; probe++) {
    const candidate = headings[probe];
    if (!includeChildren || candidate.level <= anchor.level) {
      return candidate.startOffset;
    }
  }
  return content.length;
}

export function readSection(content: string, headingPath: string[], includeChildren: boolean): string | SectionLocateError {
  const headings = extractHeadings(content);
  const located = locateHeadingPath(headings, headingPath);
  if ("kind" in located) {
    return located;
  }
  const first = located[0];
  const end = sectionEnd(content, headings, headings.indexOf(first), includeChildren);
  return content.slice(first.startOffset, end).trimEnd();
}

export function replaceSection(content: string, headingPath: string[], newContent: string, includeChildren: boolean): string | SectionLocateError {
  const headings = extractHeadings(content);
  const located = locateHeadingPath(headings, headingPath);
  if ("kind" in located) {
    return located;
  }
  const first = located[0];
  const end = sectionEnd(content, headings, headings.indexOf(first), includeChildren);
  const head = content.slice(0, first.startOffset);
  const tail = content.slice(end);
  return (head + newContent + tail).replace(/\n+$/, "\n");
}

export function appendToSection(content: string, headingPath: string[], newContent: string): string | SectionLocateError {
  const headings = extractHeadings(content);
  const located = locateHeadingPath(headings, headingPath);
  if ("kind" in located) {
    return located;
  }
  const first = located[0];
  const end = sectionEnd(content, headings, headings.indexOf(first), true);
  const head = content.slice(0, end).trimEnd();
  const tail = content.slice(end);
  return (`${head}\n\n${newContent}\n${tail}`).replace(/\n+$/, "\n");
}
