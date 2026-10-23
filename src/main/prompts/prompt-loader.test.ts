import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPromptFile } from "./prompt-loader";

const location = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => join(location.root, "resources", "app.asar"),
    getPath: (kind: string) => join(location.root, kind === "exe" ? "Firefly_Agent.exe" : "profile") },
}));
beforeEach(() => { location.root = mkdtempSync(join(tmpdir(), "ff-prompts-contract-")); });
afterEach(() => rmSync(location.root, { force: true, recursive: true }));
function put(base: string, filename: string, content: string) {
  const folder = join(base, "prompts");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, filename), content);
}
it("loads and trims editable prompts from the installation beside the executable", () => {
  put(location.root, "soul.md", "  Garden companion\n");
  expect(loadPromptFile("soul.md")).toEqual("Garden companion");
});
it("uses shipped defaults when a user has no override", () => {
  put(location.root, "chat_system.md", "Talk about plants");
  expect(loadPromptFile("chat_system.md")).toEqual("Talk about plants");
});
it("prioritizes a profile override over the shipped content", () => {
  put(location.root, "soul.md", "Shipped personality");
  put(join(location.root, "profile"), "soul.md", "  Personal personality\n");
  expect(loadPromptFile("soul.md")).toEqual("Personal personality");
});
it("returns empty text for an absent prompt", () => {
  expect(loadPromptFile("absent.md")).toEqual("");
});
