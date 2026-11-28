import { expect, it } from "vitest";
import path from "node:path";
import { fireflyDataDirectory, fireflyExportManifest } from "./firefly-data-paths";

it.each(["chats", "runs", "tasks"] as const)("uses the current %s directory without touching disk", kind => {
  expect(fireflyDataDirectory(path.join("fixture", "profile"), kind))
    .toBe(path.join("fixture", "profile", `firefly-${kind}`));
});

it("uses the current export manifest", () => {
  expect(fireflyExportManifest("fixture")).toBe(path.join("fixture", ".firefly-export-manifest.json"));
});
