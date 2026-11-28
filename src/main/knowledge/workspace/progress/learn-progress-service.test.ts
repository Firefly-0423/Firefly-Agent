import { describe, expect, it, vi } from "vitest";
import { applyUpdate, loadProgress, saveProgress } from "./learn-progress-service";
import type { LearnProgress } from "./learn-progress-types";
import type { ObsidianWorkspaceService } from "../obsidian/obsidian-workspace-service";

function workspace(content: string | Error, contentHash = "hash-1") {
  const edit = vi.fn(async (_request: Parameters<ObsidianWorkspaceService["edit"]>[0]) => ({
    path: "learn/progress.md",
    operation: "replace_file",
    newContentHash: "n",
    bytesWritten: 1,
  }));
  const service = {
    readFile: vi.fn(async () => {
      if (content instanceof Error) throw content;
      return { path: "learn/progress.md", content, contentHash, headings: [] };
    }),
    edit,
  };
  return { service: service as unknown as ObsidianWorkspaceService, edit, readFile: service.readFile };
}

function progress(overrides: Partial<LearnProgress> = {}): LearnProgress {
  return { schemaVersion: 1, updatedAt: "2026-01-01T00:00:00.000Z", topics: {}, ...overrides };
}

function frontmatter(body: string): string {
  return `---\n${body}\n---\n\n# 学习进度\n`;
}

describe("loadProgress", () => {
  it("returns an empty progress with a fresh timestamp when the file cannot be read", async () => {
    const { service } = workspace(new Error("ENOENT"));
    const result = await loadProgress(service);
    expect(result).toEqual({ schemaVersion: 1, updatedAt: expect.any(String), topics: {} });
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false);
  });

  it("returns empty progress when the file has no YAML frontmatter", async () => {
    const { service } = workspace("# just notes\n\nnothing structured here");
    expect(await loadProgress(service)).toEqual({ schemaVersion: 1, updatedAt: expect.any(String), topics: {} });
  });

  it("returns empty progress when the frontmatter is not valid YAML", async () => {
    const { service } = workspace(frontmatter("topics: [unclosed"));
    expect(await loadProgress(service)).toEqual({ schemaVersion: 1, updatedAt: expect.any(String), topics: {} });
  });

  it("returns empty progress when the frontmatter is not an object", async () => {
    const { service } = workspace(frontmatter("just-a-scalar"));
    expect(await loadProgress(service)).toEqual({ schemaVersion: 1, updatedAt: expect.any(String), topics: {} });
  });

  it("parses optional fields, normalizes unknown values and clamps mastery", async () => {
    const { service } = workspace(frontmatter([
      "currentTopic: TypeScript",
      "currentSection: Generics",
      "nextStep: practice",
      "updatedAt: 2026-02-03T04:05:06.000Z",
      "topics:",
      "  zeta:",
      "    status: mastered",
      "    mastery: 150",
      "    unresolvedQuestions:",
      "      - why",
      "      - 3",
      "    lastStudiedAt: 2026-02-04T00:00:00.000Z",
      "  alpha:",
      "    status: something-else",
      "    mastery: -5",
      "    unresolvedQuestions: not-an-array",
    ].join("\n")));

    const result = await loadProgress(service);
    expect(result.currentTopic).toBe("TypeScript");
    expect(result.currentSection).toBe("Generics");
    expect(result.nextStep).toBe("practice");
    expect(result.updatedAt).toBe("2026-02-03T04:05:06.000Z");
    expect(result.topics.zeta).toEqual({
      status: "mastered",
      mastery: 100,
      unresolvedQuestions: ["why"],
      lastStudiedAt: "2026-02-04T00:00:00.000Z",
    });
    expect(result.topics.alpha.status).toBe("learning");
    expect(result.topics.alpha.mastery).toBe(0);
    expect(result.topics.alpha.unresolvedQuestions).toEqual([]);
    expect(Number.isNaN(Date.parse(result.topics.alpha.lastStudiedAt))).toBe(false);
  });

  it("keeps only reviewing/learning/mastered statuses and ignores non-object topic entries", async () => {
    const { service } = workspace(frontmatter([
      "topics:",
      "  reviewing-topic:",
      "    status: reviewing",
      "    mastery: 50",
      "  learning-topic:",
      "    status: learning",
      "    mastery: 0",
      "  broken: not-an-object",
    ].join("\n")));
    const result = await loadProgress(service);
    expect(result.topics["reviewing-topic"].status).toBe("reviewing");
    expect(result.topics["learning-topic"].status).toBe("learning");
    expect(result.topics.broken).toBeUndefined();
  });
});

describe("saveProgress", () => {
  it("replaces the existing file with hashed, sorted and formatted content", async () => {
    const { service, edit } = workspace("old", "current-hash");
    const value = progress({
      currentTopic: "TypeScript",
      currentSection: "Generics",
      nextStep: "write a test",
      topics: {
        zeta: { status: "mastered", mastery: 90, unresolvedQuestions: [], lastStudiedAt: "2026-01-02T00:00:00.000Z" },
        alpha: { status: "learning", mastery: 10, unresolvedQuestions: ["what is a generic?"], lastStudiedAt: "2026-01-03T00:00:00.000Z" },
      },
    });

    expect(await saveProgress(value, service)).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
    const request = edit.mock.calls[0][0] as {
      operation: string;
      path: string;
      content: string;
      expectedContentHash: string;
    };
    expect(request.operation).toBe("replace_file");
    expect(request.path).toBe("learn/progress.md");
    expect(request.expectedContentHash).toBe("current-hash");
    expect(request.content).toMatch(/^---\n/);
    expect(request.content).toContain("**当前主题**：TypeScript > Generics");
    expect(request.content).toContain("## 主题掌握度");
    expect(request.content).toContain("✅ **zeta** — 90% (已掌握)");
    expect(request.content).toContain("📖 **alpha** — 10% (学习中)");
    expect(request.content).toContain("  - 待解决的问题：\n    - [ ] what is a generic?");
    expect(request.content).toContain("## 下一步\n\nwrite a test");
    expect(request.content.indexOf("**alpha**")).toBeLessThan(request.content.indexOf("**zeta**"));
    expect(request.content).toContain("mastery: 90");
  });

  it("uses reviewing formatting and omits empty optional sections", async () => {
    const { service, edit } = workspace("old");
    const value = progress({
      topics: {
        review: { status: "reviewing", mastery: 55, unresolvedQuestions: [], lastStudiedAt: "2026-01-02T00:00:00.000Z" },
      },
    });
    expect(await saveProgress(value, service)).toBe(true);
    const content = (edit.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain("🔄 **review** — 55% (复习中)");
    expect(content).not.toContain("**当前主题**");
    expect(content).not.toContain("## 下一步");
  });

  it("refuses to recreate a file that no longer exists", async () => {
    const { service, edit } = workspace(new Error("ENOENT"));
    expect(await saveProgress(progress(), service)).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });

  it("swallows write failures and reports false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, edit } = workspace("old");
    edit.mockRejectedValueOnce(new Error("disk full"));
    expect(await saveProgress(progress(), service)).toBe(false);
    expect(warn).toHaveBeenCalledWith("[LearnProgress] 保存进度失败：", expect.any(Error));
    warn.mockRestore();
  });
});

describe("applyUpdate", () => {
  it("returns the original object when there is no meaningful change", () => {
    const original = progress();
    const result = applyUpdate(original, { hasMeaningfulChange: false, topic: "ignored", masteryDelta: 20 });
    expect(result).toBe(original);
  });

  it("creates a new topic and applies mastery, status and questions", () => {
    const original = progress();
    const result = applyUpdate(original, {
      hasMeaningfulChange: true,
      topic: "TypeScript",
      section: "Generics",
      masteryDelta: 60,
      unresolvedQuestionsAdded: ["what is T?"],
      nextStep: "read the handbook",
    });
    expect(result).not.toBe(original);
    expect(result.currentTopic).toBe("TypeScript");
    expect(result.currentSection).toBe("Generics");
    expect(result.nextStep).toBe("read the handbook");
    expect(result.topics.TypeScript).toMatchObject({
      status: "reviewing",
      mastery: 60,
      unresolvedQuestions: ["what is T?"],
    });
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.topics.TypeScript.lastStudiedAt))).toBe(false);
  });

  it("infers mastered at 90 and preserves an explicit status", () => {
    const mastered = applyUpdate(progress(), { hasMeaningfulChange: true, topic: "ts", masteryDelta: 90 });
    expect(mastered.topics.ts.status).toBe("mastered");

    const explicit = applyUpdate(progress(), { hasMeaningfulChange: true, topic: "ts", masteryDelta: 90, status: "learning" });
    expect(explicit.topics.ts.status).toBe("learning");
  });

  it("clamps mastery to the 0-100 range", () => {
    const start = progress({
      topics: { ts: { status: "learning", mastery: 95, unresolvedQuestions: [], lastStudiedAt: "2026-01-01T00:00:00.000Z" } },
    });
    expect(applyUpdate(start, { hasMeaningfulChange: true, topic: "ts", masteryDelta: 50 }).topics.ts.mastery).toBe(100);
    expect(applyUpdate(start, { hasMeaningfulChange: true, topic: "ts", masteryDelta: -500 }).topics.ts.mastery).toBe(0);
  });

  it("deduplicates added questions and removes resolved ones", () => {
    const start = progress({
      topics: { ts: { status: "learning", mastery: 20, unresolvedQuestions: ["a", "b"], lastStudiedAt: "2026-01-01T00:00:00.000Z" } },
    });
    const result = applyUpdate(start, {
      hasMeaningfulChange: true,
      topic: "ts",
      unresolvedQuestionsAdded: ["b", "c"],
      unresolvedQuestionsResolved: ["a", "missing"],
    });
    expect(result.topics.ts.unresolvedQuestions).toEqual(["b", "c"]);
  });

  it("updates section and nextStep without touching an absent topic", () => {
    const start = progress({ currentTopic: "old", topics: { old: { status: "learning", mastery: 5, unresolvedQuestions: [], lastStudiedAt: "2026-01-01T00:00:00.000Z" } } });
    const result = applyUpdate(start, { hasMeaningfulChange: true, section: "new section", nextStep: "new step" });
    expect(result.currentTopic).toBe("old");
    expect(result.currentSection).toBe("new section");
    expect(result.nextStep).toBe("new step");
    expect(result.topics).toEqual(start.topics);
  });
});
