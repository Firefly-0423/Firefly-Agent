import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { synchronizeManagedSkillDirectories } from "./directory-install";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-directory-skills-"));
  roots.push(root);
  const sourceDirectory = path.join(root, "source");
  const userSkillsDir = path.join(root, "user", "skills");
  fs.mkdirSync(path.join(sourceDirectory, "public-skill", "references"), { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, "public-skill", "SKILL.md"), "original");
  fs.writeFileSync(path.join(sourceDirectory, "public-skill", "references", "guide.md"), "reference");
  return { root, sourceDirectory, userSkillsDir, expectedIds: ["public-skill"] };
}

it("installs a validated directory once, then leaves identical installed bytes intact", () => {
  const options = fixture();
  expect(synchronizeManagedSkillDirectories(options)).toEqual({ installed: ["public-skill"], updated: [], preserved: [] });
  const body = path.join(options.userSkillsDir, "public-skill", "SKILL.md");
  expect(fs.readFileSync(body, "utf8")).toBe("original");
  expect(synchronizeManagedSkillDirectories(options)).toEqual({ installed: [], updated: [], preserved: [] });
  expect(fs.readdirSync(options.userSkillsDir).filter(name => name === "public-skill")).toHaveLength(1);
});

it("updates unchanged managed files atomically and retains a backup", () => {
  const options = fixture();
  synchronizeManagedSkillDirectories(options);
  fs.writeFileSync(path.join(options.sourceDirectory, "public-skill", "SKILL.md"), "replacement");
  expect(synchronizeManagedSkillDirectories(options).updated).toEqual(["public-skill"]);
  expect(fs.readFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md"), "utf8")).toBe("replacement");
  expect(fs.readFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md.pre-firefly.bak"), "utf8")).toBe("original");
  expect(synchronizeManagedSkillDirectories(options)).toEqual({ installed: [], updated: [], preserved: [] });
});

it.each(["body", "attachment", "new file"])("preserves the entire bundle after a user changes the %s", change => {
  const options = fixture();
  synchronizeManagedSkillDirectories(options);
  const directory = path.join(options.userSkillsDir, "public-skill");
  const changed = change === "body" ? path.join(directory, "SKILL.md")
    : change === "attachment" ? path.join(directory, "references", "guide.md")
      : path.join(directory, "user-note.md");
  fs.writeFileSync(changed, "user data");
  fs.writeFileSync(path.join(options.sourceDirectory, "public-skill", "SKILL.md"), "replacement");
  expect(synchronizeManagedSkillDirectories(options).preserved).toEqual(["public-skill"]);
  expect(fs.readFileSync(changed, "utf8")).toBe("user data");
  expect(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8")).not.toBe("replacement");
});

it("does not overwrite an unknown same-name skill or unrelated user skill", () => {
  const options = fixture();
  fs.mkdirSync(path.join(options.userSkillsDir, "public-skill"), { recursive: true });
  fs.mkdirSync(path.join(options.userSkillsDir, "private-skill"));
  fs.writeFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md"), "user version");
  fs.writeFileSync(path.join(options.userSkillsDir, "private-skill", "SKILL.md"), "private");
  expect(synchronizeManagedSkillDirectories(options).preserved).toEqual(["public-skill"]);
  expect(fs.readFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md"), "utf8")).toBe("user version");
  expect(fs.readFileSync(path.join(options.userSkillsDir, "private-skill", "SKILL.md"), "utf8")).toBe("private");
});

it("does not claim ownership of an identical same-name user directory without managed metadata", () => {
  const options = fixture();
  const userDirectory = path.join(options.userSkillsDir, "public-skill");
  fs.mkdirSync(options.userSkillsDir, { recursive: true });
  fs.cpSync(path.join(options.sourceDirectory, "public-skill"), userDirectory, { recursive: true });
  expect(synchronizeManagedSkillDirectories(options).preserved).toEqual(["public-skill"]);
  fs.writeFileSync(path.join(options.sourceDirectory, "public-skill", "SKILL.md"), "replacement");
  expect(synchronizeManagedSkillDirectories(options).preserved).toEqual(["public-skill"]);
  expect(fs.readFileSync(path.join(userDirectory, "SKILL.md"), "utf8")).toBe("original");
});

it("keeps the prior valid installation when replacement fails before commit", () => {
  const options = fixture();
  synchronizeManagedSkillDirectories(options);
  fs.writeFileSync(path.join(options.sourceDirectory, "public-skill", "SKILL.md"), "replacement");
  const rename = fs.renameSync;
  const intercepted = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === path.join(options.userSkillsDir, "public-skill") && String(from).includes("skills-managed-staging")) {
      throw new Error("public commit failure");
    }
    return rename(from, to);
  });
  try { expect(() => synchronizeManagedSkillDirectories(options)).toThrow("public commit failure"); }
  finally { intercepted.mockRestore(); }
  expect(fs.readFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md"), "utf8")).toBe("original");
});

it("restores the prior installation when managed metadata cannot be committed", () => {
  const options = fixture();
  synchronizeManagedSkillDirectories(options);
  fs.writeFileSync(path.join(options.sourceDirectory, "public-skill", "SKILL.md"), "replacement");
  const rename = fs.renameSync;
  const statePath = path.join(options.userSkillsDir, ".firefly-managed-skills.json");
  const intercepted = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === statePath) throw new Error("metadata commit failure");
    return rename(from, to);
  });
  try { expect(() => synchronizeManagedSkillDirectories(options)).toThrow("metadata commit failure"); }
  finally { intercepted.mockRestore(); }
  expect(fs.readFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md"), "utf8")).toBe("original");
  expect(synchronizeManagedSkillDirectories(options).updated).toEqual(["public-skill"]);
});

it("keeps installed Skills intact when managed metadata is unreadable", () => {
  const options = fixture();
  synchronizeManagedSkillDirectories(options);
  const statePath = path.join(options.userSkillsDir, ".firefly-managed-skills.json");
  fs.writeFileSync(statePath, "{");
  fs.writeFileSync(path.join(options.sourceDirectory, "public-skill", "SKILL.md"), "replacement");
  expect(() => synchronizeManagedSkillDirectories(options)).toThrow();
  expect(fs.readFileSync(path.join(options.userSkillsDir, "public-skill", "SKILL.md"), "utf8")).toBe("original");
  expect(fs.readFileSync(statePath, "utf8")).toBe("{");
});

it("rejects a linked packaged attachment before writing any user Skill", () => {
  const options = fixture();
  const outside = path.join(options.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(options.sourceDirectory, "public-skill", "references", "linked"), "junction");
  expect(() => synchronizeManagedSkillDirectories(options)).toThrow(/SKILL_(DIRECTORY|MIGRATION)_LINK/);
  expect(fs.existsSync(path.join(options.userSkillsDir, "public-skill"))).toBe(false);
});

it("rejects packaged bytes that differ from the directory manifest before writing", () => {
  const options = fixture();
  expect(() => synchronizeManagedSkillDirectories({ ...options, expectedFileHashes: {
    "public-skill/SKILL.md": "0".repeat(64),
    "public-skill/references/guide.md": "0".repeat(64),
  } })).toThrow("SKILL_DIRECTORY_HASH_MISMATCH");
  expect(fs.existsSync(options.userSkillsDir)).toBe(false);
});

it("rejects linked installed destinations without writing through them", () => {
  const options = fixture();
  const outside = path.join(options.root, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(options.userSkillsDir, { recursive: true });
  fs.symlinkSync(outside, path.join(options.userSkillsDir, "public-skill"), "junction");
  expect(() => synchronizeManagedSkillDirectories(options)).toThrow(/SKILL_(DIRECTORY|MIGRATION)_LINK/);
  expect(fs.readdirSync(outside)).toEqual([]);
});

it("exposes an exclusive tree copy that cannot replace an existing destination", async () => {
  const options = fixture();
  const module = await import("./directory-install");
  const copy = (module as Record<string, unknown>).copyManagedSkillTreeExclusive;
  expect(copy, "external install must reuse the exclusive managed tree copy").toBeTypeOf("function");
  const destination = path.join(options.root, "exclusive-copy");
  (copy as (from: string, to: string) => void)(path.join(options.sourceDirectory, "public-skill"), destination);
  expect(() => (copy as (from: string, to: string) => void)(path.join(options.sourceDirectory, "public-skill"), destination)).toThrow();
  expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe("original");
});
