import DOMPurify from "dompurify";

export const SVG_SOURCE_LIMIT = 20000;
export const HANDWRITTEN_SVG_SOURCE_LIMIT = 60000;

export function isOverSourceLimit(source: string): boolean {
  const length = source.length;
  return length > SVG_SOURCE_LIMIT;
}

export function isOverHandwrittenSvgLimit(source: string): boolean {
  const length = source.length;
  return length > HANDWRITTEN_SVG_SOURCE_LIMIT;
}

export function stripFontImports(svg: string): string {
  const externalFonts = /@import\s+url\([^)]*fonts\.googleapis\.com[^)]*\);?/g;
  return svg.replace(externalFonts, "");
}

export function sanitizeSvg(svg: string): string {
  const forbiddenElements = ["script", "foreignObject", "iframe", "embed", "object", "link"];
  const forbiddenAttributes = ["src", "href", "xlink:href"];
  const safe = DOMPurify.sanitize(svg, {
    FORBID_TAGS: forbiddenElements,
    FORBID_ATTR: forbiddenAttributes,
  });
  if (typeof safe === "string") return safe;
  return "";
}
