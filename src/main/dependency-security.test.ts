import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

const requireDependency = createRequire(import.meta.url);

describe("security dependency compatibility", () => {
  it("shares the RxJS runtime and nominal types with the AG-UI client", () => {
    const requireAgui = createRequire(requireDependency.resolve("@ag-ui/client"));
    expect(requireAgui.resolve("rxjs")).toBe(requireDependency.resolve("rxjs"));
    expect(requireAgui("rxjs").Observable).toBe(requireDependency("rxjs").Observable);
  });

  it("preserves HTTPS proxy and NO_PROXY matching without using npm configuration as runtime routing", () => {
    const { getProxyForUrl } = requireDependency("proxy-from-env");
    try {
      // A host-provided lowercase proxy must not override this isolated fixture.
      for (const key of ["https_proxy", "http_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(key, "");
      vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:8080");
      vi.stubEnv("ALL_PROXY", "");
      vi.stubEnv("NO_PROXY", "internal.example.test");
      vi.stubEnv("npm_config_https_proxy", "http://npm.example.test:8080");
      expect(getProxyForUrl("https://public.example.test/resource")).toBe("http://proxy.example.test:8080");
      expect(getProxyForUrl("https://internal.example.test/resource")).toBe("");
      expect(getProxyForUrl("/relative-path")).toBe("");
      vi.stubEnv("HTTPS_PROXY", "");
      expect(getProxyForUrl("https://public.example.test/resource")).toBe("");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains ONNX static protobuf decoding, int64 values and empty bytes", () => {
    const { onnx } = requireDependency("onnx-proto");
    const message = onnx.ModelProto.fromObject({
      irVersion: "8",
      modelVersion: "9007199254740993",
      producerName: "Firefly public fixture",
      graph: {
        name: "fixture",
        initializer: [{ name: "empty", dims: [0], dataType: 1, rawData: Buffer.alloc(0) }],
      },
    });
    const encoded = onnx.ModelProto.encode(message).finish();
    const decoded = onnx.ModelProto.decode(encoded);
    expect(decoded.modelVersion.toString()).toBe("9007199254740993");
    expect(decoded.graph.initializer[0].rawData.byteLength).toBe(0);
    expect(onnx.ModelProto.toObject(decoded, { longs: String }).producerName).toBe("Firefly public fixture");
    expect(Buffer.from(onnx.ModelProto.encode(decoded).finish())).toEqual(Buffer.from(encoded));
  });

  it("loads the existing Transformers image API against the patched sharp binary", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import sharp from "sharp";
      import { RawImage, env } from "@xenova/transformers";
      env.allowRemoteModels = false;
      const png = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer();
      const image = await RawImage.fromBlob(new Blob([png], { type: "image/png" }));
      const resized = await image.resize(4, 2);
      console.log(JSON.stringify({ size: image.size, channels: image.channels, resized: resized.size, pixels: Array.from(image.data) }));
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000, windowsHide: true });
    expect(JSON.parse(output.trim())).toEqual({
      size: [2, 1], channels: 3, resized: [4, 2], pixels: [255, 0, 0, 0, 255, 0],
    });
  }, 25_000);

  it("round-trips XLSX conditional formatting through the scoped UUID upgrade", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("public fixture");
    sheet.addRow([1]);
    sheet.addRow([2]);
    sheet.addConditionalFormatting({
      ref: "A1:A2",
      rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }] }],
    });
    const bytes = await workbook.xlsx.writeBuffer();
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(bytes);
    expect(restored.getWorksheet("public fixture")?.getCell("A2").value).toBe(2);
    expect(restored.getWorksheet("public fixture")?.conditionalFormattings[0].rules[0].type).toBe("dataBar");
  });
});
