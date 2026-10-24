import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "./skill-registry";
import type { SkillEntry } from "./types";

let collection: SkillRegistry;
const scratchDirectories: string[] = [];

function record(id: string, changes: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id, name: "Capability " + id, description: "Rules for " + id,
    dirPath: join(tmpdir(), "uncreated-firefly-capability", id),
    bodyPath: join(tmpdir(), "uncreated-firefly-capability", id, "SKILL.md"),
    source: "user", enabled: true, references: [], ...changes,
  };
}

function onDisk(id: string, content: string, attachments: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "firefly-registry-contract-"));
  scratchDirectories.push(folder);
  const bodyPath = join(folder, "SKILL.md");
  writeFileSync(bodyPath, content, "utf8");
  mkdirSync(join(folder, "references"));
  for (const [name, text] of Object.entries(attachments)) {
    writeFileSync(join(folder, "references", name), text, "utf8");
  }
  collection.register(record(id, { dirPath: folder, bodyPath, references: Object.keys(attachments) }));
  return { folder, bodyPath };
}

beforeEach(() => { collection = new SkillRegistry(); });
afterEach(() => {
  for (const folder of scratchDirectories.splice(0)) rmSync(folder, { force: true, recursive: true });
});

describe("Capability visibility", () => {
  it("distinguishes registered, enabled and absent IDs in registration order", () => {
    const active = record("outline-notes");
    const dormant = record("draft-mail", { enabled: false });
    collection.register(active);
    collection.register(dormant);
    expect(collection.getById(active.id)).toEqual(active);
    expect(collection.getById("not-registered")).toBeUndefined();
    expect(collection.getAll()).toEqual([active, dormant]);
    expect(collection.getEnabled()).toEqual([active]);
  });

  it("enables and disables an entry without creating an unknown ID", () => {
    collection.register(record("review-diff", { enabled: false }));
    collection.setEnabled("review-diff", true);
    expect(collection.getById("review-diff")?.enabled).toBe(true);
    expect(collection.getEnabled().map(({ id }) => id)).toEqual(["review-diff"]);
    collection.setEnabled("review-diff", false);
    expect(collection.getEnabled()).toEqual([]);
    collection.setEnabled("unknown-id", true);
    expect(collection.getAll()).toHaveLength(1);
  });

  it("evaluates availability dynamically without overwriting the saved enabled flag", () => {
    let allowed = false;
    collection.register(record("audio-guide"));
    collection.setAvailability("audio-guide", () => allowed);
    expect(collection.getEnabled()).toEqual([]);
    expect(collection.getAll()[0].enabled).toBe(true);
    allowed = true;
    expect(collection.getEnabled().map(({ id }) => id)).toEqual(["audio-guide"]);
  });

  it("filters mode-scoped entries and rejects obsolete modes", () => {
    collection.register(record("editor-guide", { modes: ["code"] }));
    collection.register(record("task-guide", { modes: ["work"] }));
    collection.register(record("shared-guide"));
    collection.register(record("off-guide", { enabled: false, modes: ["work"] }));
    expect(collection.getEnabledForMode("work").map(({ id }) => id)).toEqual(["task-guide", "shared-guide"]);
    expect(collection.getEnabledForMode("code").map(({ id }) => id)).toEqual(["editor-guide", "shared-guide"]);
    expect(() => collection.getEnabledForMode("learn" as never)).toThrow(/^INVALID_SKILL_MODE$/);
  });

  it("honors per-mode overrides while keeping disabled and unavailable entries out", () => {
    collection.register(record("workflow", { modes: ["work"] }));
    collection.register(record("switched-off", { enabled: false }));
    collection.register(record("unavailable"));
    collection.setAvailability("unavailable", () => false);
    const choices = {
      workflow: { code: true, work: false },
      "switched-off": { code: true }, unavailable: { code: true },
    };
    expect(collection.getEnabledForMode("code", choices).map(({ id }) => id)).toEqual(["workflow"]);
    expect(collection.getEnabledForMode("work", choices)).toEqual([]);
    expect(() => collection.getEnabledForMode("learn" as never, choices)).toThrow(/^INVALID_SKILL_MODE$/);
  });

  it("removes an entry and its availability probe", () => {
    collection.register(record("retired-guide"));
    collection.setAvailability("retired-guide", () => false);
    expect(collection.unregister("retired-guide")).toBe(true);
    expect(collection.unregister("retired-guide")).toBe(false);
    expect(collection.getById("retired-guide")).toBeUndefined();
    collection.register(record("retired-guide"));
    expect(collection.getEnabled().map(({ id }) => id)).toEqual(["retired-guide"]);
  });
});

describe("Reading capability documents", () => {
  it("strips metadata and caches the first body until a registration replaces it", () => {
    const location = onDisk("notebook", "---\nname: notebook\ndescription: Notebook policy\ntools: [notes_read]\n---\n# Notes\nKeep citations.");
    expect(collection.getBody("notebook")).toBe("# Notes\nKeep citations.");
    expect(collection.getBody("notebook")).not.toContain("description");
    writeFileSync(location.bodyPath, "---\nname: notebook\ndescription: Revised policy\n---\n# Revised body", "utf8");
    expect(collection.getBody("notebook")).toBe("# Notes\nKeep citations.");
    collection.register(record("notebook", { bodyPath: location.bodyPath, dirPath: location.folder }));
    expect(collection.getBody("notebook")).toBe("# Revised body");
  });

  it("returns null for absent registrations or deleted body files", () => {
    expect(collection.getBody("absent-guide")).toBeNull();
    const { bodyPath } = onDisk("missing-document", "Temporary instructions");
    unlinkSync(bodyPath);
    expect(collection.getBody("missing-document")).toBeNull();
  });

  it("supports trimmed plain documents without metadata", () => {
    onDisk("legacy-guide", " \nPlain instructions only.\n ");
    expect(collection.getBody("legacy-guide")).toBe("Plain instructions only.");
  });

  it("reads an allowlisted attachment verbatim and reports deletion as null", () => {
    const location = onDisk("references-guide", "# Guide", { "format.txt": "Keep trailing whitespace.\n" });
    expect(collection.getReference("references-guide", "format.txt")).toBe("Keep trailing whitespace.\n");
    unlinkSync(join(location.folder, "references", "format.txt"));
    expect(collection.getReference("references-guide", "format.txt")).toBeNull();
  });

  it.each([
    "../../outside/private.txt", "unlisted.txt", "format.txt/../../outside",
    "..\\outside.txt", "nested/file.txt", "two..dots.txt",
  ])("rejects an unlisted or unsafe reference name %j", (name) => {
    const location = onDisk("guarded-guide", "# Guard", { "format.txt": "Approved reference" });
    expect(collection.getReference("guarded-guide", name)).toBeNull();
    collection.register(record("guarded-guide", {
      dirPath: location.folder, bodyPath: location.bodyPath,
      references: name === "unlisted.txt" ? ["format.txt"] : [name],
    }));
    expect(collection.getReference("guarded-guide", name)).toBeNull();
  });

  it("does not read references for an unknown skill", () => {
    expect(collection.getReference("unknown-guide", "attachment.txt")).toBeNull();
  });
});
