import type { Plugin } from "unified";

type HastNode = {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type?: string;
};

const fileLinkOrigin = "https://firefly.invalid/__file-link__/";

export function encodeStreamdownFileHref(href: string): string {
  if (!href.startsWith("file:///")) return href;
  const encoded = new TextEncoder().encode(href);
  let octets = "";
  for (const code of encoded) octets += String.fromCharCode(code);
  const token = btoa(octets).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return fileLinkOrigin + token;
}

export function decodeStreamdownFileHref(href: string): string | null {
  if (!href.startsWith(fileLinkOrigin)) return null;
  const token = href.slice(fileLinkOrigin.length);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
  let decoded: string;
  try {
    const octets = atob(base64);
    const codes = Uint8Array.from(octets, (letter) => letter.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(codes);
  } catch { return null; }
  return decoded.startsWith("file:///") ? decoded : null;
}

function rewriteLinks(branch: HastNode): void {
  if (branch.type === "element") {
    const address = branch.tagName === "a" ? branch.properties?.href : undefined;
    if (typeof address === "string") branch.properties!.href = encodeStreamdownFileHref(address);
  }
  branch.children?.forEach(rewriteLinks);
}

export const encodeStreamdownFileLinksInHast: Plugin = () => (tree: HastNode) => {
  rewriteLinks(tree);
};
