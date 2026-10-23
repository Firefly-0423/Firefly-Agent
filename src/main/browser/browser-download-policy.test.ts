import path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadHost, isRiskyDownloadName, sanitizeDownloadFileName, uniqueDownloadPath } from "./browser-download-policy";

describe("sanitizeDownloadFileName", () => {
  it("drops path parts, control and reserved characters, and trailing dots", () => {
    expect(sanitizeDownloadFileName("..\\..\\Windows\\evil.txt")).toBe("evil.txt");
    expect(sanitizeDownloadFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFileName("a<b>c:d|e?f*g.txt")).toBe("a_b_c_d_e_f_g.txt");
    expect(sanitizeDownloadFileName("report.pdf. ")).toBe("report.pdf");
    expect(sanitizeDownloadFileName("\u0001\u0007x.txt")).toBe("__x.txt");
    expect(sanitizeDownloadFileName("fdp\u202Egpj.exe")).not.toMatch(/\u202e/);
  });
  it("avoids reserved Windows device names and bounds the length", () => {
    expect(sanitizeDownloadFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeDownloadFileName("nul")).toBe("_nul");
    const long = sanitizeDownloadFileName(`${"a".repeat(400)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });
  it("falls back for empty or non-string names", () => {
    expect(sanitizeDownloadFileName("")).toBe("download");
    expect(sanitizeDownloadFileName("...")).toBe("download");
    expect(sanitizeDownloadFileName(undefined, "file")).toBe("file");
  });
});

describe("isRiskyDownloadName", () => {
  it("flags executable and script types, including a double extension", () => {
    for (const name of ["setup.exe", "a.PS1", "x.bat", "doc.pdf.exe", "run.js", "lib.dll", "a.lnk"]) expect(isRiskyDownloadName(name), name).toBe(true);
    for (const name of ["report.pdf", "photo.png", "archive.zip", "notes.txt", "noextension"]) expect(isRiskyDownloadName(name), name).toBe(false);
  });
});

describe("uniqueDownloadPath", () => {
  it("numbers the name until it is free", () => {
    const taken = new Set([path.join("d", "a.txt"), path.join("d", "a (1).txt")]);
    expect(uniqueDownloadPath("d", "a.txt", p => taken.has(p))).toBe(path.join("d", "a (2).txt"));
    expect(uniqueDownloadPath("d", "b.txt", p => taken.has(p))).toBe(path.join("d", "b.txt"));
  });
});

describe("downloadHost", () => {
  it("accepts a plain HTTPS chain and returns the final host", () => {
    expect(downloadHost(["https://a.example/x", "https://cdn.example/y.zip"])).toBe("cdn.example");
  });
  it("refuses http, credentials, blob/data/file and malformed or empty chains", () => {
    for (const chain of [["http://a.example/x"], ["https://u:p@a.example/x"], ["blob:https://a.example/id"], ["data:text/plain,x"], ["file:///C:/x"], ["not a url"], []]) {
      expect(downloadHost(chain), JSON.stringify(chain)).toBeNull();
    }
    expect(downloadHost(["https://a.example/x", "http://b.example/y"])).toBeNull();
  });
});
