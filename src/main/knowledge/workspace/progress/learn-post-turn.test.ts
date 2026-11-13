import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ObsidianWorkspaceService, obsidianWorkspace } from "../obsidian/obsidian-workspace-service";
import { runLearnPostTurnHook } from "./learn-post-turn";
import { openKnowledgeWorkspace } from "../knowledge-workspace";
import { defaultProgressContent } from "./learn-progress-types";
import { extractProgress } from "./learn-progress-extractor";
import { saveProgress } from "./learn-progress-service";

/** A vault that already carries a learning progress file (the only opt-in the product honours). */
function seedLearnProgress(root: string): void {
  fs.mkdirSync(path.join(root, "learn"), { recursive: true });
  fs.writeFileSync(path.join(root, "learn/progress.md"), defaultProgressContent());
}

vi.mock("./learn-progress-extractor", () => ({
  extractProgress: vi.fn(async () => ({ hasMeaningfulChange: true, topic: "test-topic", masteryDelta: 10 })),
}));

it("keeps short quiz evidence and delayed progress in the captured workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "progress-isolation-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "progress-other-"));
  try {
    seedLearnProgress(root);
    const workspace = new ObsidianWorkspaceService();
    workspace.configure({ enabled: true, vaultPath: root });
    obsidianWorkspace.configure({ enabled: true, vaultPath: other });
    await runLearnPostTurnHook({ workspace, accessLevel: "scoped", assistantMessage: "正确", userMessage: "测验",
      quizEvidence: [{ questionId: "question", learningObjective: "test-topic", userAnswer: true, correctAnswer: true, grading: "correct" }], adapter: {}, cfg: {}, systemPrompt: "" } as never);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "learn/progress.md"))).toBe(true));
    await vi.waitFor(() => expect(fs.readFileSync(path.join(root, "learn/progress.md"), "utf8")).toContain("test-topic"));
    expect(fs.readdirSync(other)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

it.each(["read-only", "per-action"])("does not write silent progress with %s permissions", async (accessLevel) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "progress-permission-"));
  try {
    seedLearnProgress(root);
    const before = fs.readFileSync(path.join(root, "learn/progress.md"), "utf8");
    const workspace = new ObsidianWorkspaceService();
    workspace.configure({ enabled: true, vaultPath: root });
    await runLearnPostTurnHook({ workspace, accessLevel, assistantMessage: "teaching ".repeat(20), userMessage: "study", adapter: {}, cfg: {}, systemPrompt: "" } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.readFileSync(path.join(root, "learn/progress.md"), "utf8")).toBe(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(["scoped", "full"])("does not initialize progress for an ordinary Obsidian Vault with %s permissions", async (accessLevel) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-only-"));
  try {
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.writeFileSync(path.join(root, "note.md"), "ordinary note");
    const workspace = openKnowledgeWorkspace("work", root)!;
    expect((await workspace.readFile({ path: "note.md" })).content).toBe("ordinary note");
    vi.mocked(extractProgress).mockClear();
    await runLearnPostTurnHook({ workspace, accessLevel, assistantMessage: "ordinary notes ".repeat(20), userMessage: "summarize notes", adapter: {}, cfg: {}, systemPrompt: "" } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.existsSync(path.join(root, "learn"))).toBe(false);
    expect(extractProgress).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("ordinary note");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(["legacy-progress", "explicit-init"])("continues %s progress in Work", async (origin) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "progress-opt-in-"));
  try {
    seedLearnProgress(root);
    const workspace = openKnowledgeWorkspace("work", root)!;
    if (origin === "legacy-progress") {
      expect(await saveProgress({ schemaVersion: 1, updatedAt: "2026-09-26T00:00:00.000Z", topics: {
        "test-topic": { status: "learning", mastery: 20, unresolvedQuestions: ["keep existing question"], lastStudiedAt: "2026-09-26T00:00:00.000Z" },
      } }, workspace)).toBe(true);
    }
    await runLearnPostTurnHook({ workspace, accessLevel: "scoped", assistantMessage: "teaching ".repeat(20), userMessage: "continue", adapter: {}, cfg: {}, systemPrompt: "" } as never);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(root, "learn/progress.md"), "utf8")).toContain(origin === "legacy-progress" ? "mastery: 30" : "mastery: 10"));
    if (origin === "legacy-progress") expect(fs.readFileSync(path.join(root, "learn/progress.md"), "utf8")).toContain("keep existing question");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("does not recreate progress removed before a delayed save", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "progress-removed-"));
  try {
    seedLearnProgress(root);
    const workspace = openKnowledgeWorkspace("work", root)!;
    fs.unlinkSync(path.join(root, "learn/progress.md"));
    expect(await saveProgress({ schemaVersion: 1, updatedAt: new Date().toISOString(), topics: {} }, workspace)).toBe(false);
    expect(fs.existsSync(path.join(root, "learn/progress.md"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
