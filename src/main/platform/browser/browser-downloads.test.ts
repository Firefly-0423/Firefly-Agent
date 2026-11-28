import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserDownloads, type DownloadItemLike } from "./browser-downloads";

class FakeItem extends EventEmitter {
  received = 0; savePath = ""; cancelled = false;
  constructor(public chain: string[] = ["https://files.example/a.zip"], public name = "a.zip", public total = 100, public gesture = true) { super(); }
  getURLChain() { return this.chain; } getFilename() { return this.name; } getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; } hasUserGesture() { return this.gesture; }
  setSavePath(p: string) { this.savePath = p; } getSavePath() { return this.savePath; }
  cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); }
}
const asItem = (item: FakeItem) => item as unknown as DownloadItemLike;

let clock = 0, counter = 0, existing: Set<string>, settings: { askWhereToSave: boolean; folder: string | null };
let changes: unknown[][], opened: string[], revealed: string[], openResult: string;
function make(extra: { maxConcurrent?: number; maxBytes?: number } = {}) {
  return createBrowserDownloads({
    getSettings: () => settings, defaultDirectory: () => "DL", exists: p => existing.has(p), ensureDirectory: vi.fn(),
    openPath: async p => { opened.push(p); return openResult; }, showInFolder: p => { revealed.push(p); },
    now: () => (clock += 1000), newId: () => `d${++counter}`, onChange: list => { changes.push([...list]); }, ...extra,
  });
}
beforeEach(() => { clock = 0; counter = 0; existing = new Set(); settings = { askWhereToSave: false, folder: null }; changes = []; opened = []; revealed = []; openResult = ""; });

describe("browser downloads", () => {
  it("accepts a user-initiated HTTPS download, saves it under a unique sanitised name, and completes", () => {
    existing.add(path.join("DL", "a.zip"));
    const downloads = make(), item = new FakeItem(["https://files.example/a.zip"], "..\\..\\a.zip");
    expect(downloads.handle(asItem(item))).toBe(true);
    expect(item.savePath).toBe(path.join("DL", "a (1).zip"));
    expect(downloads.list()[0]).toMatchObject({ id: "d1", fileName: "a (1).zip", host: "files.example", state: "progressing", totalBytes: 100, openable: true });
    item.received = 100; item.emit("done", {}, "completed");
    expect(downloads.list()[0]).toMatchObject({ state: "completed", receivedBytes: 100 });
  });

  it("refuses a download the user did not trigger, a non-HTTPS chain, an oversize file and a fourth concurrent one", () => {
    const downloads = make({ maxBytes: 1000 });
    expect(downloads.handle(asItem(new FakeItem(undefined, "a.zip", 100, false)))).toBe(false);
    expect(downloads.handle(asItem(new FakeItem(["http://x.example/a.zip"])))).toBe(false);
    expect(downloads.handle(asItem(new FakeItem(["https://u:p@x.example/a.zip"])))).toBe(false);
    expect(downloads.handle(asItem(new FakeItem(undefined, "big.iso", 5000)))).toBe(false);
    for (let i = 0; i < 3; i++) expect(downloads.handle(asItem(new FakeItem(undefined, `f${i}.txt`)))).toBe(true);
    expect(downloads.handle(asItem(new FakeItem(undefined, "f4.txt")))).toBe(false);
    expect(downloads.list()).toHaveLength(3);
  });

  it("cancels a download that grows past the size cap even when the server announced no size", () => {
    const downloads = make({ maxBytes: 1000 }), item = new FakeItem(undefined, "stream.bin", 0);
    expect(downloads.handle(asItem(item))).toBe(true);
    item.received = 1001; item.emit("updated", {}, "progressing");
    expect(item.cancelled).toBe(true);
    expect(downloads.list()[0].state).toBe("cancelled");
  });

  it("marks an interrupted download failed", () => {
    const downloads = make(), item = new FakeItem();
    downloads.handle(asItem(item)); item.emit("updated", {}, "interrupted");
    expect(downloads.list()[0].state).toBe("failed");
  });

  it("uses the chosen folder, or leaves the path to the system dialog when asked to", () => {
    settings = { askWhereToSave: false, folder: "C:/Chosen" };
    const a = new FakeItem(); make().handle(asItem(a));
    expect(a.savePath).toBe(path.join("C:/Chosen", "a.zip"));
    settings = { askWhereToSave: true, folder: null };
    const downloads = make(), b = new FakeItem();
    expect(downloads.handle(asItem(b))).toBe(true);
    expect(b.savePath).toBe("");
    b.savePath = path.join("Picked", "renamed.pdf"); b.emit("done", {}, "completed");
    expect(downloads.list()[0]).toMatchObject({ fileName: "renamed.pdf", state: "completed", openable: true });
  });

  it("opens only finished, non-executable files; executables can only be revealed", async () => {
    const downloads = make(), pdf = new FakeItem(undefined, "ok.pdf"), exe = new FakeItem(undefined, "setup.exe");
    downloads.handle(asItem(pdf)); downloads.handle(asItem(exe));
    expect(await downloads.open("d1")).toBe(false); // still downloading
    pdf.emit("done", {}, "completed"); exe.emit("done", {}, "completed");
    existing.add(path.join("DL", "ok.pdf")); existing.add(path.join("DL", "setup.exe"));
    expect(downloads.list().map(d => [d.fileName, d.openable])).toEqual([["setup.exe", false], ["ok.pdf", true]]);
    expect(await downloads.open("d1")).toBe(true);
    expect(opened).toEqual([path.join("DL", "ok.pdf")]);
    expect(await downloads.open("d2")).toBe(false);
    expect(opened).toHaveLength(1);
    expect(downloads.reveal("d2")).toBe(true);
    expect(revealed).toEqual([path.join("DL", "setup.exe")]);
  });

  it("refuses to open a file that has gone, and reports a failed open", async () => {
    const downloads = make(), item = new FakeItem(undefined, "ok.pdf");
    downloads.handle(asItem(item)); item.emit("done", {}, "completed");
    expect(await downloads.open("d1")).toBe(false); // not on disk
    existing.add(path.join("DL", "ok.pdf")); openResult = "no association";
    expect(await downloads.open("d1")).toBe(false);
  });

  it("removes finished entries, cancels running ones, and clear keeps what is still running", () => {
    const downloads = make(), a = new FakeItem(), b = new FakeItem(undefined, "b.zip"), c = new FakeItem(undefined, "c.zip");
    downloads.handle(asItem(a)); downloads.handle(asItem(b)); downloads.handle(asItem(c));
    a.emit("done", {}, "completed");
    expect(downloads.remove("d2")).toBe(false);
    expect(downloads.cancel("d1")).toBe(false);
    expect(downloads.cancel("d2")).toBe(true);
    expect(downloads.remove("d1")).toBe(true);
    downloads.clear();
    expect(downloads.list().map(d => d.id)).toEqual(["d3"]);
    expect(downloads.remove("nope")).toBe(false);
  });

  it("reports progress and state changes to the window", () => {
    const downloads = make(), item = new FakeItem(); downloads.handle(asItem(item));
    const before = changes.length;
    item.received = 10; item.emit("updated", {}, "progressing"); // the fake clock moves 1s per call, past the throttle
    expect(changes.length).toBeGreaterThan(before);
    expect((changes.at(-1) as Array<{ receivedBytes: number }>)[0].receivedBytes).toBe(10);
  });

  it("dispose cancels what is in flight", () => {
    const downloads = make(), item = new FakeItem(); downloads.handle(asItem(item));
    downloads.dispose();
    expect(item.cancelled).toBe(true);
  });
});
