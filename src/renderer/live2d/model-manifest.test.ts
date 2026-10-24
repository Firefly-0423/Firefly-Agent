import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildMotionIndexMap } from "./model-manifest";

describe("buildMotionIndexMap", () => {
  it("indexes unnamed Firefly motions by their exact ordinal string", () => {
    const map = buildMotionIndexMap({
      FileReferences: { Motions: {
        Idle: [{ File: "idle-0.json" }, { File: "idle-1.json" }],
        Tap: [{ File: "tap-0.json" }, { File: "tap-1.json" }],
      } },
    });

    expect(map.get("Idle")?.get("0")).toBe(0);
    expect(map.get("Idle")?.get("1")).toBe(1);
    expect(map.get("Tap")?.get("1")).toBe(1);
  });

  it("keeps author-provided motion names for existing manifests", () => {
    const map = buildMotionIndexMap({
      FileReferences: { Motions: { Gesture: [{ Name: "wave", File: "wave.json" }] } },
    });
    expect(map.get("Gesture")?.get("wave")).toBe(0);
  });

  it("resolves every expression the Live2D rules use against the bundled Firefly manifest", async () => {
    const manifest = JSON.parse(readFileSync("src/renderer/public/models/firefly/Firefly.model3.json", "utf8"));
    const expressions = new Set(manifest.FileReferences.Expressions.map((entry: { Name: string }) => entry.Name));
    const { LIVE2D_DEFAULT_EXPRESSION, LIVE2D_WORKING_EXPRESSION } = await import("../../shared/live2d-actions");
    const ruleExpressions = [
      LIVE2D_DEFAULT_EXPRESSION,
      LIVE2D_WORKING_EXPRESSION,
      "expression1",
      "expression2",
      "expression9",
      "expression10",
    ];
    for (const name of ruleExpressions) {
      expect(expressions.has(name), name).toBe(true);
    }
    expect(manifest.HitAreas.map((area: { Name: string }) => area.Name)).toEqual(["Body", "Head"]);
  });
});
