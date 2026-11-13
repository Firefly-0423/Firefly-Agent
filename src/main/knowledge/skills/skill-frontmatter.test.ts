import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import matter from "@11ty/gray-matter";
import { parseSkillFrontmatter, scanSkills } from "./skill-scanner";
import { SkillRegistry } from "./skill-registry";
import { parseSkillMatter } from "./skill-frontmatter";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const document = (metadata: string, body = "  # Body\n\nText  ") => `---\n${metadata}\n---\n${body}`;
const metadata = "name: fixture\ndescription: A fixture";

describe("Skill frontmatter data-only boundary", () => {
  // Replace the old executable engine before passing any JS-labelled text.
  // The fixture contains no executable code and the stub is never eval'd.
  it.each(["js", "javascript", "JS", "JavaScript", " js "])("rejects %s before engine dispatch with an observable reason", (language) => {
    const engines = (matter as unknown as { engines: Record<string, { parse: (source: string) => object }> }).engines;
    const parser = vi.spyOn(engines.javascript, "parse").mockReturnValue({ name: "fixture", description: "A fixture" });
    const onError = vi.fn();
    const result = parseSkillFrontmatter(`\uFEFF---${language}\r\nignored fixture data\r\n---\r\nBody`, onError);
    expect(result).toBeNull();
    expect(parser).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("SKILL_FRONTMATTER_UNSUPPORTED_LANGUAGE");
  });

  it.each(["toml", "constructor", "toString", "__proto__"])("rejects unsupported language %s", language => {
    const onError = vi.fn();
    expect(parseSkillFrontmatter(`---${language}\nignored fixture data\n---\nBody`, onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith("SKILL_FRONTMATTER_UNSUPPORTED_LANGUAGE");
  });

  it.each(["!custom", "!!js/function", "!!js/regexp", "!!js/undefined"])("rejects custom/executable tag %s without registering a tag handler", tag => {
    const onError = vi.fn();
    expect(parseSkillFrontmatter(document(`${metadata}\nextra: ${tag} harmless-text`), onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith("SKILL_FRONTMATTER_PARSE_ERROR");
  });

  it.each(["tools: [{ toString: harmless-data }]", "version: { toString: harmless-data }"])("rejects non-coercible metadata without throwing: %s", field => {
    const onError = vi.fn();
    expect(parseSkillFrontmatter(document(`${metadata}\n${field}`), onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith("SKILL_FRONTMATTER_PARSE_ERROR");
  });

  it.each(["yaml", "yml", "YAML", "json"])("ignores global engine replacements for allowed %s data", language => {
    const engines = (matter as unknown as { engines: Record<string, unknown> }).engines;
    const previous = engines[language];
    const replacement = vi.fn(() => ({ name: "wrong", description: "wrong" }));
    engines[language] = replacement;
    try {
      const raw = language === "json" ? '{"name":"fixture","description":"A fixture"}' : metadata;
      expect(parseSkillFrontmatter(`---${language}\n${raw}\n---\nBody`)?.name).toBe("fixture");
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete engines[language];
      else engines[language] = previous;
    }
  });

  it.each(["yaml", "json"])("retains __proto__/constructor as own %s data without changing the object prototype", language => {
    const data = language === "yaml" ? `${metadata}\n__proto__: { description: own-data }\nconstructor: ordinary-value`
      : '{"name":"fixture","description":"A fixture","__proto__":{"description":"own-data"},"constructor":"ordinary-value"}';
    const parsed = parseSkillMatter(`---${language}\n${data}\n---\nBody`);
    expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.data, "__proto__")).toBe(true);
    expect(parsed.data.__proto__).toEqual({ description: "own-data" });
    expect(Object.hasOwn(parsed.data, "constructor")).toBe(true);
    expect(parsed.data.constructor).toBe("ordinary-value");
    expect(parseSkillFrontmatter(`---${language}\n${data}\n---\nBody`)?.description).toBe("A fixture");
  });

  it("reports a rejected directory and still discovers its valid sibling", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-frontmatter-"));
    roots.push(root);
    for (const [id, raw] of [["good", document("name: good\ndescription: good")], ["bad", "---js\n# only a comment\n---\nBody"]]) {
      fs.mkdirSync(path.join(root, id));
      fs.writeFileSync(path.join(root, id, "SKILL.md"), raw);
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(scanSkills(root, "user").map(entry => entry.id)).toEqual(["good"]);
    expect(warning.mock.calls.flat().join(" ")).toContain("SKILL_FRONTMATTER_UNSUPPORTED_LANGUAGE");
  });

  it.each(["js", "yaml"])("does not return unsafe %s frontmatter as raw body after the scanned file changes", language => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-frontmatter-registry-"));
    roots.push(root);
    const skillDir = path.join(root, "fixture");
    fs.mkdirSync(skillDir);
    const file = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(file, document(metadata));
    const registry = new SkillRegistry();
    for (const entry of scanSkills(root, "user")) registry.register(entry);
    // A comment-only JS header exercises rejection without ever reaching eval.
    fs.writeFileSync(file, language === "js" ? "---js\n# only a comment\n---\nBody"
      : document(`${metadata}\nextra: !custom harmless-text`));
    expect(registry.getBody("fixture")).toBeNull();
    fs.writeFileSync(file, "legacy plain body");
    expect(registry.getBody("fixture")).toBe("legacy plain body");
  });
});

describe("Skill frontmatter compatibility", () => {
  it.each(["", "yaml", "yml", "YAML"])("accepts the existing YAML language %s", language => {
    expect(parseSkillFrontmatter(`---${language}\n${metadata}\n---\nBody`)?.body).toBe("Body");
  });

  it("accepts explicit JSON as data", () => {
    expect(parseSkillFrontmatter('---json\n{"name":"fixture","description":"JSON","tools":["read"]}\n---\nBody'))
      .toMatchObject({ name: "fixture", description: "JSON", tools: ["read"], body: "Body" });
  });

  it("preserves BOM, CRLF, block scalars, indented delimiter text, and body trim", () => {
    const raw = "\uFEFF---\r\nname: fixture\r\ndescription: |-\r\n  First\r\n  ---\r\n  Last\r\ntools:\r\n  - read\r\n---\r\n  # Body\r\n\r\n---\r\nTail  \r\n";
    expect(parseSkillFrontmatter(raw)).toMatchObject({ description: "First\n---\nLast", tools: ["read"], body: "# Body\r\n\r\n---\r\nTail" });
  });

  it.each([
    ["plain text", null], ["---\n---\nBody", null], ["---\n# comment\n---\nBody", null],
    ["---\nnull\n---\nBody", null], ["---\n42\n---\nBody", null], ["---\n[one, two]\n---\nBody", null],
    ["----\nname: fixture\ndescription: d\n---\nBody", null],
  ])("retains invalid or absent metadata result for %j", (raw, expected) => {
    expect(parseSkillFrontmatter(raw!)).toBe(expected);
  });

  it("preserves the existing unterminated metadata-only document", () => {
    expect(parseSkillFrontmatter(`---\n${metadata}`)).toMatchObject({ name: "fixture", body: "" });
  });

  it("preserves the existing closing-delimiter tail as body", () => {
    expect(parseSkillFrontmatter(`---\n${metadata}\n---tail\nBody`)?.body).toBe("tail\nBody");
  });

  it.each([
    ["0123", "83"], ["0x10", "16"], ["0b11", "3"], ["1:20", "80"], ["1_:20", "80"],
    ["1e3", "1000"], ["1.2e3", "1200"], [".2e3", "200"], ["1_000.5", "1000.5"], ["1:20.5", "80.5"],
    ["08", "08"], ["0o123", "0o123"], ["01.2", "01.2"], ["123_", "123_"], ["0_", "0_"], ["0:10", "0:10"], ["-.2", "-.2"],
    ["yes", "yes"], ["no", "no"], ["on", "on"], ["off", "off"], ["true", "true"],
  ])("preserves legacy version scalar %s", (value, expected) => {
    expect(parseSkillFrontmatter(document(`${metadata}\nversion: ${value}`))?.version).toBe(expected);
  });

  it("preserves dates as Date-derived version/tools text and plain boolean-like names", () => {
    expect(parseSkillFrontmatter(document("name: on\ndescription: yes\nversion: 2026-10-06\ntools: [2026-10-06, no, true, 0123]")))
      .toMatchObject({ name: "on", description: "yes", version: String(new Date("2026-10-06T00:00:00.000Z")),
        tools: [String(new Date("2026-10-06T00:00:00.000Z")), "no", "true", "83"] });
  });

  it("preserves the exposed string projection of YAML binary and set metadata", () => {
    expect(parseSkillFrontmatter(document(`${metadata}\nversion: !!binary SGVsbG8=\ntools: [!!binary SGk=, !!set { read: null }]`)))
      .toMatchObject({ version: "Hello", tools: ["Hi", "[object Object]"] });
  });

  it("preserves aliases, merge precedence, mode normalization and metadata projection", () => {
    expect(parseSkillFrontmatter(document("base: &base\n  name: fixture\n  description: inherited\n  version: 0123\n<<: *base\ndescription: local\ntools: [read, 12]\nmodes: [work, CODE, unknown, code]\neffectKind: verification\nhiddenFromUi: true")))
      .toEqual({ name: "fixture", description: "local", version: "83", tools: ["read", "12"], modes: ["work", "code"],
        effectKind: "verification", hiddenFromUi: true, body: "# Body\n\nText" });
  });
});
