import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

describe("application update packaging", () => {
  it("does not package a publish feed before compatible Firefly releases exist", () => {
    const config = load(readFileSync(resolve(process.cwd(), "electron-builder.yml"), "utf8")) as {
      publish?: unknown[];
    };

    expect(config.publish).toEqual([]);
  });
});
