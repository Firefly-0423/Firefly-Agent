import { it, expect, describe } from "vitest";
import { encodeStreamdownFileLinksInHast, decodeStreamdownFileHref, encodeStreamdownFileHref } from "./streamdown-file-link";

describe("Workspace links through Markdown sanitization", () => {
  const marker = "https://firefly.invalid/__file-link__/";
  it("walks nested anchors and leaves regular links and non-anchor attributes alone", () => {
    const local = { type: "element", tagName: "a", properties: { href: "file:///D:/notes/outline.md#L28" } };
    const web = { type: "element", tagName: "a", properties: { href: "https://docs.example.org" } };
    const image = { type: "element", tagName: "img", properties: { href: "file:///D:/notes/photo.png" } };
    const document = { type: "root", children: [{ type: "element", tagName: "section", children: [local, web, image] }] };
    const visit = encodeStreamdownFileLinksInHast() as unknown as (input: typeof document) => void;
    visit(document);
    expect(local.properties.href.startsWith(marker)).toEqual(true);
    expect(decodeStreamdownFileHref(local.properties.href)).toEqual("file:///D:/notes/outline.md#L28");
    expect(web.properties.href).toEqual("https://docs.example.org");
    expect(image.properties.href).toEqual("file:///D:/notes/photo.png");
  });
  it.each(["file:///D:/workspace/lib/parser.ts#L28", "file:///D:/笔记/任务.md"])("restores the original file URL %s", (original) => {
    const placeholder = encodeStreamdownFileHref(original);
    expect(placeholder).toMatch(/^https:\/\/firefly\.invalid\/__file-link__\//);
    expect(decodeStreamdownFileHref(placeholder)).toEqual(original);
    expect(decodeStreamdownFileHref(placeholder.replace("firefly.invalid", "untrusted.example"))).toEqual(null);
  });
  it("requires an application placeholder containing a file URL", () => {
    const ordinary = "https://docs.example.org/guide";
    expect(encodeStreamdownFileHref(ordinary)).toEqual(ordinary);
    const foreign = encodeStreamdownFileHref("file:///D:/review/notes.md").replace("firefly.invalid", "foreign.example");
    for (const invalid of [marker + "%%invalid!", foreign, marker + btoa(ordinary), marker])
      expect(decodeStreamdownFileHref(invalid)).toEqual(null);
  });
});
