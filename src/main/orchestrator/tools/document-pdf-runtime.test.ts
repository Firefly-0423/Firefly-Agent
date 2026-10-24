/** Phase evidence for the pre-fix operation. This diagnostic uses synthetic
 * workspace files and real system fonts; it does not assert repaired behavior. */
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getRunReviewTracker } from "../review/run-review-tracker";

it.each(["first-import", "warm-import"])("records legacy real PDF phases: %s", async trial => {
  const parent = path.resolve("output/pdf-runtime-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const output = path.join(root, "report.pdf");
  fs.writeFileSync(output, Buffer.from("%PDF-synthetic-old\0"));
  const start = performance.now();
  const evidence = (stage: string, details = {}) => console.info("[PdfLegacyEvidence]", JSON.stringify({ trial, stage, elapsedMs: +(performance.now() - start).toFixed(3), ...details }));
  const span = <T>(stage: string, fn: () => T): T => {
    evidence(stage + ":start"); const begin = performance.now();
    try { const value = fn(); evidence(stage + ":end", { durationMs: +(performance.now() - begin).toFixed(3) }); return value; }
    catch (error) { evidence(stage + ":error", { durationMs: +(performance.now() - begin).toFixed(3), name: (error as Error).name }); throw error; }
  };
  let doc: PDFKit.PDFDocument | undefined;
  let stream: fs.WriteStream | undefined;
  let selectedCollection = false;
  let outcome = "";
  let failure: unknown;
  const read = fs.readFileSync;
  const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (typeof file === "string" && /^C:\\Windows\\Fonts\\/.test(file)) return span("system-font-read", () => (read as any)(file, ...args));
    return (read as any)(file, ...args);
  }) as any);
  try {
    evidence("pdfkit-import:start");
    const { default: PDF } = await import("pdfkit");
    evidence("pdfkit-import:end");
    span("baseline-capture", () => getRunReviewTracker(root).captureBefore(trial, output));
    doc = span("construct", () => new PDF());
    stream = span("target-stream-open", () => fs.createWriteStream(output));
    for (const event of ["open", "finish", "close", "error"] as const) stream.on(event, () => evidence("stream:" + event));
    doc.pipe(stream);
    for (const file of ["C:\\Windows\\Fonts\\msyh.ttc", "C:\\Windows\\Fonts\\simsun.ttc", "C:\\Windows\\Fonts\\simhei.ttf"]) {
      const exists = fs.existsSync(file);
      evidence("font-probe", { resource: path.win32.basename(file), exists, ...(exists ? { bytes: fs.statSync(file).size } : {}) });
      if (exists) {
        selectedCollection = file.endsWith(".ttc");
        span("font-selection-without-face", () => doc!.font(file));
        break;
      }
    }
    span("title-render", () => doc!.fontSize(22).text("标题", { align: "center" }));
    doc.moveDown(); doc.fontSize(12);
    span("paragraph-render", () => doc!.text("段落一", { align: "left" }));
    doc.moveDown(0.5);
    span("finalize", () => doc!.end());
    evidence("wait-finish:start");
    await new Promise<void>((resolve, reject) => { stream!.on("finish", resolve); stream!.on("error", reject); });
    evidence("wait-finish:end"); outcome = "generated";
  } catch (error) {
    failure = error; outcome = "generation-error";
    evidence("generation-error", { name: (error as Error).name, collectionSubsetError: String((error as Error).message).includes("createSubset") });
    // Preserve the old test's failure wait, without increasing any timeout.
    evidence("legacy-failure-wait:start");
    await new Promise(resolve => setTimeout(resolve, 50));
    evidence("legacy-failure-wait:end");
  } finally {
    try { span("legacy-directory-cleanup", () => fs.rmSync(root, { recursive: true, force: true })); }
    catch (error) { evidence("legacy-cleanup-denied", { code: (error as NodeJS.ErrnoException).code }); }
    const closed = stream && !stream.closed ? new Promise<void>(resolve => stream!.once("close", resolve)) : Promise.resolve();
    doc?.destroy(); stream?.destroy(); await closed;
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    readSpy.mockRestore();
    evidence("diagnostic-disposal:end", { outcome });
  }
  if (failure) {
    expect(selectedCollection).toBe(true);
    expect(String((failure as Error).message)).toContain("createSubset");
  } else expect(outcome).toBe("generated");
});
