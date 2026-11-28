import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMemoryFile, writeMemoryFile, resolveMemoryPath } from "./memory-store-io";
import type { MemoryStore } from "./memory-types";

const directory = vi.hoisted(() => ({ value: "" }));
vi.mock("electron", () => ({ app: { getPath: () => directory.value } }));
beforeEach(() => { directory.value = mkdtempSync(join(tmpdir(), "ff-io-contract-")); });
afterEach(() => rmSync(directory.value, { force: true, recursive: true }));
const sample = (): MemoryStore => ({
  version: 4, schemaVersion: 2,
  l0: { language: "en", nickname: "Moss", preferredName: "River", occupation: "botanist",
    longTermInterests: "ferns", permanentNote: "weekend walks", updatedAt: 43, isPinned: true },
  l1: { currentProject: "garden", recentGoals: "plant herbs", recentPreferences: "mint", generatedAt: 48, roundCount: 7 },
  l2: [{ content: "Keeps a seed journal", id: "memory:journal", triggerText: "seeds", sourceConversationId: "garden-chat",
    createdAt: 41, lastAccessedAt: 45, accessCount: 2, weight: 0.7, isPinned: false, status: "active", ragId: "rag:journal" }],
  evidence: [], conflictLogs: [], reflectionLogs: [],
});
it("locates persistence inside the Electron profile", () => {
  expect(resolveMemoryPath()).toEqual(join(directory.value, "memory.json"));
});
it.each(["memory.json", join("deep", "profile", "memory.json")])("round trips the full store at %s", relative => {
  const destination = join(directory.value, relative);
  const original = sample();
  writeMemoryFile(destination, original);
  expect(existsSync(destination)).toBe(true);
  const restored = readMemoryFile(destination);
  expect(restored).toEqual(original);
  expect(restored.l1?.roundCount).toBe(7);
});
