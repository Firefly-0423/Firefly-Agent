import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkills as discover, parseSkillFrontmatter as parse } from "./skill-scanner";
import { buildAutoInjectedSkillContext, buildSkillCatalog } from "./skill-catalog";

function document(fields: string[], body = "Follow the notebook workflow.") {
  return ["---", ...fields, "---", "", body, ""].join("\n");
}

describe("Skill document metadata", () => {
  it("returns every declared field with a clean instruction body", () => {
    const parsed = parse(document([
      "description: Assemble a notebook outline", "version: 2.4.1",
      "tools: [notes_read, outline_write]", "name: outline-notebook",
    ], "# Notebook outline\nKeep the original sources."));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      description: "Assemble a notebook outline", name: "outline-notebook", version: "2.4.1",
      tools: ["notes_read", "outline_write"], body: "# Notebook outline\nKeep the original sources.",
      modes: undefined, effectKind: undefined, hiddenFromUi: false,
    });
    expect(parsed?.body).not.toContain("description:");
  });

  it("accepts just the mandatory fields without inventing optional metadata", () => {
    const parsed = parse(document(["description: Minimal policy", "name: minimal-guide"], "A short instruction."));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      name: "minimal-guide", description: "Minimal policy", body: "A short instruction.",
      tools: undefined, version: undefined, modes: undefined, effectKind: undefined, hiddenFromUi: false,
    });
  });

  it.each([
    ["description: Missing a name"],
    ["name: missing-summary"],
    ["name: scalar-tools", "description: Tool metadata must be a list", "tools: notes_read"],
  ])("rejects incomplete or wrongly typed metadata %j", (...fields) => {
    expect(parse(document(fields))).toBeNull();
  });

  it("declines a document without a metadata delimiter", () => {
    expect(parse("An ordinary paragraph with no frontmatter.")).toBeNull();
  });

  it.each([
    ["[learn]", []],
    ["[work, learn, code]", ["work", "code"]],
    ["[unknown]", []],
    ["[code]", ["code"]],
    ["[invalid, CODE, learn]", ["code"]],
    ['[" CODE ", work, code, work]', ["code", "work"]],
  ])("normalizes declared modes %s without broadening an empty result", (modes, expected) => {
    const parsed = parse(document(["name: mode-policy", "description: Mode constraints", "modes: " + modes]));
    expect(parsed).not.toBeNull();
    expect(parsed?.modes).toEqual(expected);
  });
});

describe("Directory discovery", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "firefly-scan-contract-")); });
  afterEach(() => { rmSync(root, { force: true, recursive: true }); });

  function install(folderName: string, metadata = ["name: " + folderName, "description: Local workflow"]) {
    const folder = join(root, folderName);
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), document(metadata), "utf8");
    return folder;
  }

  it("exposes the skill directory identity, parsed metadata and direct reference files", () => {
    const folder = install("notebook-index", [
      "description: Index research notes", "name: notebook-index", "tools: [notes_read]",
    ]);
    const refs = join(folder, "references");
    mkdirSync(refs);
    writeFileSync(join(refs, "layout.md"), "Layout rules", "utf8");
    writeFileSync(join(refs, "dataset.json"), "{}", "utf8");
    const results = discover(root, "builtin");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "notebook-index", name: "notebook-index", description: "Index research notes",
      source: "builtin", enabled: true, dirPath: folder, bodyPath: join(folder, "SKILL.md"),
      tools: ["notes_read"],
    });
    expect(results[0].references.slice().sort()).toEqual(["dataset.json", "layout.md"]);
    expect(results[0].references).not.toContain("SKILL.md");
  });

  it("uses the folder as ID even when the display name differs", () => {
    const folder = install("folder-identity", ["description: Named differently", "name: display-title"]);
    const results = discover(root, "user");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "folder-identity", name: "display-title", dirPath: folder, bodyPath: join(folder, "SKILL.md"),
    });
  });

  it("ignores directories with incomplete metadata or no skill document", () => {
    install("missing-description", ["name: missing-description"]);
    mkdirSync(join(root, "empty-folder"));
    expect(discover(root, "builtin")).toEqual([]);
  });

  it("returns no entries for both a missing root and an empty root", () => {
    expect(discover(join(root, "absent-root"), "builtin")).toEqual([]);
    expect(discover(root, "builtin")).toEqual([]);
    const nested = join(root, "vacant");
    mkdirSync(nested);
    expect(discover(nested, "builtin")).toEqual([]);
  });

  it("returns no references when no references directory exists", () => {
    install("standalone");
    expect(discover(root, "builtin")[0].references).toEqual([]);
  });

  it("does not descend into directories under references", () => {
    const folder = install("reference-boundary");
    const refs = join(folder, "references");
    mkdirSync(join(refs, "nested"), { recursive: true });
    writeFileSync(join(refs, "policy.txt"), "Public attachment", "utf8");
    writeFileSync(join(refs, "nested", "private.txt"), "Nested attachment", "utf8");
    expect(discover(root, "builtin")[0].references).toEqual(["policy.txt"]);
  });

  it("discovers every sibling and marks each with the requested source", () => {
    install("review-notes");
    install("assemble-notes");
    const results = discover(root, "user");
    expect(results.map(({ id }) => id).sort()).toEqual(["assemble-notes", "review-notes"]);
    expect(results.map(({ source }) => source)).toEqual(["user", "user"]);
  });

  it("loads the compound manifest including ordered dependencies and its default disabled switch", () => {
    const folder = install("compound-workflow");
    const manifest = {
      id: "compound-workflow", entry: "workflow.ts", version: "2.7.0", defaultEnabled: false,
      dependencies: ["notes_read", "outline_write"], autoInject: true,
      autoPlayPolicy: "explicit_selection_or_delegate",
    };
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest), "utf8");
    const results = discover(root, "builtin");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      enabled: false, manifest, tools: ["notes_read", "outline_write"], version: "2.7.0",
    });
  });

  it.each(["{broken-json", '{"id":"another-folder","version":"2","defaultEnabled":false,"entry":"run.ts","dependencies":[]}'])(
    "falls back to ordinary enabled behavior for an unusable manifest %j", (payload) => {
      const folder = install("manifest-fallback");
      writeFileSync(join(folder, "manifest.json"), payload, "utf8");
      const [entry] = discover(root, "builtin");
      expect(entry.enabled).toBe(true);
      expect(entry.manifest).toBeUndefined();
    },
  );
});

describe("Shipped diagram capability", () => {
  it("appears in selection without an automatic-injection claim", () => {
    const root = resolve(__dirname, "../../../skills");
    const found = discover(root, "builtin").find(({ id }) => id === "diagram");
    expect(found).toBeDefined();
    expect(found?.manifest).toBeUndefined();
    const raw = readFileSync(join(root, "diagram", "SKILL.md"), "utf8");
    expect(raw).not.toMatch(/^autoInject:/m);
    expect(buildSkillCatalog([found!])).toContain("diagram");
    const bodyReader = vi.fn(() => raw);
    expect(buildAutoInjectedSkillContext([found!], bodyReader)).toBe("");
    expect(bodyReader).not.toHaveBeenCalled();
  });
});