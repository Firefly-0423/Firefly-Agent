import { describe, expect, it } from "vitest";
import { normalizeDeclaredInputModalities, normalizeInputModalities, normalizeInputModalitiesSource } from "./input-modalities";

describe("normalizeInputModalities", () => {
  it("keeps only text and image, de-duplicated, in a fixed order", () => {
    expect(normalizeInputModalities(["image", "text", "image", "audio"])).toEqual(["text", "image"]);
    expect(normalizeInputModalities(["image"])).toEqual(["image"]);
    expect(normalizeInputModalities(["text"])).toEqual(["text"]);
  });

  it("treats anything that is not a list of known modalities as undeclared", () => {
    expect(normalizeInputModalities(undefined)).toBeUndefined();
    expect(normalizeInputModalities(null)).toBeUndefined();
    expect(normalizeInputModalities([])).toBeUndefined();
    expect(normalizeInputModalities(["audio", 7, {}])).toBeUndefined();
    expect(normalizeInputModalities("text+image")).toBeUndefined();
    expect(normalizeInputModalities({ input: ["text"] })).toBeUndefined();
  });
});

describe("normalizeInputModalitiesSource", () => {
  it("accepts only the two declared origins", () => {
    expect(normalizeInputModalitiesSource("vendor-api")).toBe("vendor-api");
    expect(normalizeInputModalitiesSource("user")).toBe("user");
    expect(normalizeInputModalitiesSource("catalog")).toBeUndefined();
    expect(normalizeInputModalitiesSource(undefined)).toBeUndefined();
  });
});

describe("normalizeDeclaredInputModalities", () => {
  it("keeps a valid declaration with its origin", () => {
    expect(normalizeDeclaredInputModalities(["text", "image"], "vendor-api")).toEqual({
      inputModalities: ["text", "image"],
      inputModalitiesSource: "vendor-api",
    });
    expect(normalizeDeclaredInputModalities(["text"], "user")).toEqual({
      inputModalities: ["text"],
      inputModalitiesSource: "user",
    });
  });

  it("records a declaration with a missing or unknown origin as user", () => {
    expect(normalizeDeclaredInputModalities(["text", "image"], undefined)).toEqual({
      inputModalities: ["text", "image"],
      inputModalitiesSource: "user",
    });
    expect(normalizeDeclaredInputModalities(["image"], "bogus")).toEqual({
      inputModalities: ["image"],
      inputModalitiesSource: "user",
    });
  });

  it("drops the origin together with an invalid declaration, so the result is plain undeclared", () => {
    const result = normalizeDeclaredInputModalities(["audio"], "vendor-api");
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("inputModalitiesSource");
    expect(normalizeDeclaredInputModalities(undefined, "user")).toEqual({});
  });
});
