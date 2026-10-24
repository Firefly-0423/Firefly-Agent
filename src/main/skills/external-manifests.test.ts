import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ExternalSkillSourceId } from "../../shared/external-skills";
import type { ExternalFetcher, ExternalTree } from "./external-fetch";
import { EXTERNAL_SOURCES, externalSkillId } from "./external-policy";
import { discoverExternalSkills, verifyExternalSkillDeclaration } from "./external-sources";
import { digestExternalFiles, evaluateExternalSkill } from "./external-review";
import { createExternalFixture } from "./testing/external-fixtures";

const commit = "a".repeat(40), schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const text = "---\nname: text\ndescription: Summarize supplied text\n---\nSummarize only the text provided by the user.\n";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const openaiCatalog = { plugins: [{ name: "bundle", source: { source: "local", path: "./plugins/bundle" } }] };

function fixture(sourceId: ExternalSkillSourceId, catalog: unknown, input: Record<string, unknown>) {
  const payload = new Map(Object.entries({ [EXTERNAL_SOURCES[sourceId].catalogPath]: catalog, ...input })
    .map(([path, value]) => [path, Buffer.from(typeof value === "string" ? value : JSON.stringify(value))]));
  const blobs = new Map([...payload.values()].map(bytes => [gitSha(bytes), bytes]));
  const tree: ExternalTree = { commit, entries: [...payload].map(([path, bytes]) => ({ path, mode: "100644", type: "blob", sha: gitSha(bytes), size: bytes.length })) };
  const reads: string[] = [];
  const fetcher: ExternalFetcher = { resolveCommit: async () => commit, readTree: async () => tree,
    readBlob: async (_source, sha) => { reads.push(sha); const bytes = blobs.get(sha); if (!bytes) throw Error("Unknown synthetic blob"); return Buffer.from(bytes); } };
  const declarations = new Map<string, string>();
  async function discover() { return discoverExternalSkills(sourceId, fetcher, new AbortController().signal, declarations); }
  async function selected(path: string) {
    const candidates = await discover(), skill = candidates.find(item => item.path === path); expect(skill).toBeDefined();
    return verifyExternalSkillDeclaration(skill!, declarations.get(skill!.id)!, tree, fetcher, new AbortController().signal);
  }
  return { payload, tree, reads, fetcher, discover, selected };
}

function exactTextReview(f: ReturnType<typeof fixture>, declared: Awaited<ReturnType<ReturnType<typeof fixture>["selected"]>>) {
  const payload = new Map([...f.payload].filter(([path]) => path.startsWith(declared.path + "/")));
  const files = [...payload].map(([path, bytes]) => ({ path, bytes: bytes.length, blobSha1: gitSha(bytes), sha256: sha256(bytes) }));
  const licensePath = declared.path + "/LICENSE";
  const review = { ...createExternalFixture().review, sourceId: declared.sourceId, commit: declared.commit, path: declared.path,
    contentSha256: digestExternalFiles(files), licenses: [{ path: licensePath, sha256: sha256(payload.get(licensePath)!), spdx: "MIT", covers: [...payload.keys()] }] };
  return evaluateExternalSkill({ ...declared, files }, payload, [review]);
}

it("portable root manifest uses canonical skills and blocks a nested undeclared decoy", async () => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { $schema: schema, name: "bundle", version: "2.0", license: "MIT" },
    "plugins/bundle/skills/text/SKILL.md": text, "plugins/bundle/hidden/decoy/SKILL.md": text });
  const selected = await f.selected("plugins/bundle/skills/text");
  expect(selected).toMatchObject({ declaration: "verified", bundle: { name: "bundle", version: "2.0", license: "MIT" }, compatibilityFormat: "openai-portable" });
  expect((await f.selected("plugins/bundle/hidden/decoy")).blockers).toContain("DEPENDENCY_BLOCKED");
});

it("portable inline OpenAI overlay replaces the legacy overlay instead of merging hooks", async () => {
  const legacy = { name: "legacy", skills: "./elsewhere", hooks: "./legacy-hooks.json" };
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { $schema: schema, name: "bundle", extensions: { "com.openai": { interface: { displayName: "Safe text" } } } },
    "plugins/bundle/.codex-plugin/plugin.json": legacy, "plugins/bundle/skills/text/SKILL.md": text });
  expect(await f.selected("plugins/bundle/skills/text")).toMatchObject({ declaration: "verified", blockers: ["REVIEW_REQUIRED"] });
  expect(f.reads).not.toContain(gitSha(Buffer.from(JSON.stringify(legacy))));
});

it("portable fallback overlay with required hooks remains a blocked mixed package", async () => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { $schema: schema, name: "bundle" },
    "plugins/bundle/.codex-plugin/plugin.json": { name: "bundle", skills: "./skills", hooks: "./hooks/run.json" }, "plugins/bundle/skills/text/SKILL.md": text });
  const skill = await f.selected("plugins/bundle/skills/text");
  expect(skill.blockers).toContain("DEPENDENCY_BLOCKED");
  expect(skill.dependencyIssues).toContainEqual({ kind: "component", path: "plugins/bundle/.codex-plugin/plugin.json", component: "hooks" });
});

it.each(["fallback", "inline"])("portable %s overlay cannot hide nested executable components behind a text approval", async placement => {
  const overlay = { name: "bundle", skills: "./skills", extensions: { "com.openai": { hooks: "./lifecycle.json" } } };
  const root = "plugins/bundle/skills/text";
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { $schema: schema, name: "bundle", license: "MIT",
    ...(placement === "inline" ? { extensions: { "com.openai": overlay } } : {}) },
    ...(placement === "fallback" ? { "plugins/bundle/.codex-plugin/plugin.json": overlay } : {}),
    "plugins/bundle/lifecycle.json": { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "DO_NOT_EXECUTE" }] }] } },
    [root + "/SKILL.md"]: text, [root + "/LICENSE"]: createExternalFixture().expectedFiles.LICENSE });
  const evaluated = exactTextReview(f, await f.selected(root));
  expect(evaluated.blockers).toContain("DEPENDENCY_BLOCKED");
  expect(evaluated.review).toBe("blocked");
  expect(evaluated.dependencyIssues?.some(issue => issue.component === "hooks" || issue.component === "unknown-extension")).toBe(true);
});

it.each(["catalog", "overlay"])("%s display metadata cannot erase a restrictive package license declaration", async placement => {
  const root = placement === "catalog" ? "skills/text" : "plugins/bundle/skills/text";
  const f = placement === "catalog"
    ? fixture("anthropic", { plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"], license: "MIT" }] }, {
      ".claude-plugin/plugin.json": { name: "bundle", license: "Proprietary" },
      [root + "/SKILL.md"]: text, [root + "/LICENSE"]: createExternalFixture().expectedFiles.LICENSE })
    : fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { $schema: schema, name: "bundle", license: "MIT" },
      "plugins/bundle/.codex-plugin/plugin.json": { name: "bundle", skills: "./skills", license: "Proprietary" },
      [root + "/SKILL.md"]: text, [root + "/LICENSE"]: createExternalFixture().expectedFiles.LICENSE });
  const evaluated = exactTextReview(f, await f.selected(root));
  expect(evaluated.blockers).toContain("LICENSE_BLOCKED");
  expect(evaluated.review).toBe("blocked");
});

it.each([true, false])("portable MCP configuration is inspected passively; servers present=%s", async nonempty => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { $schema: schema, name: "bundle" }, "plugins/bundle/skills/text/SKILL.md": text,
    "plugins/bundle/mcp.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: nonempty ? { unsafe: { type: "stdio", command: "DO_NOT_EXECUTE", args: ["script.mjs"] } } : {} } });
  const skill = await f.selected("plugins/bundle/skills/text");
  if (nonempty) { expect(skill.blockers).toContain("DEPENDENCY_BLOCKED"); expect(skill.dependencyIssues).toContainEqual({ kind: "component", path: "plugins/bundle/mcp.json", component: "mcp" }); }
  else { expect(skill.declaration).toBe("verified"); expect(skill.blockers).toEqual(["REVIEW_REQUIRED"]); }
});

it.each(["dependencies", "commands", "agents", "hooks", "mcpServers", "lspServers", "userConfig", "settings", "workflows", "channels"])("legacy Codex component %s cannot silently become a text-only import", async component => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/.codex-plugin/plugin.json": { name: "bundle", skills: "./skills", [component]: ["required-component"] }, "plugins/bundle/skills/text/SKILL.md": text });
  const skill = await f.selected("plugins/bundle/skills/text");
  expect(skill.blockers).toContain("DEPENDENCY_BLOCKED");
  expect(skill.dependencyIssues).toContainEqual({ kind: "component", path: "plugins/bundle/.codex-plugin/plugin.json", component });
});

it("legacy nested OpenAI extension does not hide an executable dependency", async () => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/.codex-plugin/plugin.json": { name: "bundle", skills: "./skills", extensions: { "com.openai": { hooks: "./hooks/run.json" } } }, "plugins/bundle/skills/text/SKILL.md": text });
  expect((await f.selected("plugins/bundle/skills/text")).blockers).toContain("DEPENDENCY_BLOCKED");
});

it("Claude local package finds default and manifest-added skill directories with canonical manifest metadata", async () => {
  const catalog = { plugins: [{ name: "bundle", source: "./plugins/claude" }] };
  const f = fixture("anthropic", catalog, { "plugins/claude/.claude-plugin/plugin.json": { name: "bundle", version: "3.0", license: "MIT", skills: "./extra-skills/" },
    "plugins/claude/skills/standard/SKILL.md": text, "plugins/claude/extra-skills/custom/SKILL.md": text, "plugins/claude/hidden/decoy/SKILL.md": text });
  for (const path of ["plugins/claude/skills/standard", "plugins/claude/extra-skills/custom"]) {
    expect(await f.selected(path)).toMatchObject({ declaration: "verified", bundle: { name: "bundle", version: "3.0", license: "MIT" }, compatibilityFormat: "claude" });
  }
  expect((await f.selected("plugins/claude/hidden/decoy")).blockers).toContain("DEPENDENCY_BLOCKED");
});

it.each([
  { entry: "entry-9", manifest: "manifest-3", want: "manifest-3" },
  { entry: "entry-9", manifest: undefined, want: "entry-9" },
  { entry: undefined, manifest: "manifest-3", want: "manifest-3" },
  { entry: undefined, manifest: undefined, want: "catalog-1" },
])("Claude canonical version uses manifest then entry then catalog: $want", async ({ entry, manifest, want }) => {
  const f = fixture("anthropic", { metadata: { version: "catalog-1" }, plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"], ...(entry ? { version: entry } : {}) }] }, {
    ".claude-plugin/plugin.json": { name: "bundle", ...(manifest ? { version: manifest } : {}) }, "skills/text/SKILL.md": text });
  expect((await f.selected("skills/text")).bundle.version).toBe(want);
});

it("a catalog version cannot hide a malformed canonical Claude manifest version", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"], version: "entry-9" }] }, {
    ".claude-plugin/plugin.json": { name: "bundle", version: { invalid: "manifest" } }, "skills/text/SKILL.md": text });
  await expect(f.selected("skills/text")).rejects.toMatchObject({ code: "CATALOG_INVALID" });
});

it.each([
  ["openai", "plugins/bundle/plugin.json", "plugins/bundle/skills/text", "100755"],
  ["openai", "plugins/bundle/plugin.json", "plugins/bundle/skills/text", "120000"],
  ["openai", "plugins/bundle/.codex-plugin/plugin.json", "plugins/bundle/skills/text", "100755"],
  ["openai", "plugins/bundle/.codex-plugin/plugin.json", "plugins/bundle/skills/text", "120000"],
  ["anthropic", ".claude-plugin/plugin.json", "skills/text", "100755"],
  ["anthropic", ".claude-plugin/plugin.json", "skills/text", "120000"],
] as const)("unsupported metadata mode stays blocked with a public path: %s %s %s %s", async (sourceId, manifestPath, skillPath, mode) => {
  const catalog = sourceId === "openai" ? openaiCatalog : { plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"] }] };
  const f = fixture(sourceId, catalog, { [manifestPath]: { name: "bundle", skills: "./skills", private: "C:\\private-local-data\\never-read.json" }, [skillPath + "/SKILL.md"]: text });
  const entry = f.tree.entries.find(item => item.path === manifestPath)!; Object.assign(entry, { mode });
  const result = await f.selected(skillPath).catch(error => ({ unexpectedError: error.code }));
  expect(result).toMatchObject({ declaration: "blocked", review: "blocked", blockers: expect.arrayContaining(["DEPENDENCY_BLOCKED"]), dependencyIssues: [{ kind: "file-mode", path: manifestPath }] });
  expect(f.reads).not.toContain(entry.sha);
  expect(JSON.stringify(result)).not.toContain("private-local-data");
});

it("unsupported MCP metadata mode preserves its public path and already known component blockers", async () => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { name: "bundle", hooks: "./lifecycle.json" },
    "plugins/bundle/.mcp.json": { mcpServers: { unsafe: { command: "DO_NOT_EXECUTE" } } }, "plugins/bundle/skills/text/SKILL.md": text });
  const entry = f.tree.entries.find(item => item.path === "plugins/bundle/.mcp.json")!; Object.assign(entry, { mode: "100755" });
  const result = await f.selected("plugins/bundle/skills/text").catch(error => ({ unexpectedError: error.code }));
  expect(result).toMatchObject({ declaration: "blocked", review: "blocked", dependencyIssues: expect.arrayContaining([
    { kind: "file-mode", path: "plugins/bundle/.mcp.json" }, { kind: "component", path: "plugins/bundle/plugin.json", component: "hooks" },
  ]) });
  expect(f.reads).not.toContain(entry.sha);
});

it("portable inline overlay still ignores an unused legacy manifest with an unsupported mode", async () => {
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/plugin.json": { name: "bundle", extensions: { "com.openai": {} } },
    "plugins/bundle/.codex-plugin/plugin.json": { name: "bundle", hooks: "./unused.json" }, "plugins/bundle/skills/text/SKILL.md": text });
  const entry = f.tree.entries.find(item => item.path === "plugins/bundle/.codex-plugin/plugin.json")!; Object.assign(entry, { mode: "100755" });
  expect(await f.selected("plugins/bundle/skills/text")).toMatchObject({ declaration: "verified", blockers: ["REVIEW_REQUIRED"] });
  expect(f.reads).not.toContain(entry.sha);
});

it("current Anthropic catalog explicit skill paths remain compatible without a plugin manifest", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"] }] }, { "skills/text/SKILL.md": text });
  expect(await f.selected("skills/text")).toMatchObject({ declaration: "verified", compatibilityFormat: "claude-catalog", blockers: ["REVIEW_REQUIRED"] });
});

it("Claude root-source explicit skills stay confined when a manifest exists", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"] }] }, {
    ".claude-plugin/plugin.json": { name: "bundle", skills: "./extra-skills" },
    "skills/text/SKILL.md": text, "skills/unlisted/SKILL.md": text, "extra-skills/unlisted/SKILL.md": text });
  expect((await f.discover()).map(skill => skill.path)).toEqual(["skills/text"]);
  const selected = await f.selected("skills/text"), path = "skills/unlisted";
  const direct = await verifyExternalSkillDeclaration({ ...selected, path, id: externalSkillId("anthropic", "anthropics/skills", path) }, "", f.tree, f.fetcher, new AbortController().signal);
  expect(direct.declaration).toBe("blocked");
  expect(direct.blockers).toContain("DEPENDENCY_BLOCKED");
});

it("Claude disjoint root catalog selections do not acquire duplicate identities from the default scan", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "first", source: "./", skills: ["./skills/first"] }, { name: "second", source: "./", skills: ["./skills/second"] }] }, {
    ".claude-plugin/plugin.json": { name: "shared-root" }, "skills/first/SKILL.md": text, "skills/second/SKILL.md": text });
  expect((await f.discover()).map(skill => skill.path).sort()).toEqual(["skills/first", "skills/second"]);
  expect((await f.selected("skills/first")).declaration).toBe("verified");
  expect((await f.selected("skills/second")).declaration).toBe("verified");
});

it("a malformed shadowed manifest license is validated rather than hidden by catalog display metadata", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./", skills: ["./skills/text"], license: "MIT" }] }, {
    ".claude-plugin/plugin.json": { name: "bundle", license: { unsupported: "Proprietary" } }, "skills/text/SKILL.md": text });
  await expect(f.selected("skills/text")).rejects.toMatchObject({ code: "CATALOG_INVALID" });
});

it("Claude strict-false entry components conflict with an existing manifest", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./plugins/claude", strict: false, skills: ["./entry-skills"] }] }, {
    "plugins/claude/.claude-plugin/plugin.json": { name: "bundle" }, "plugins/claude/entry-skills/text/SKILL.md": text });
  const skill = await f.selected("plugins/claude/entry-skills/text");
  expect(skill.blockers).toContain("DEPENDENCY_BLOCKED");
  expect(skill.dependencyIssues).toContainEqual({ kind: "declaration", path: ".claude-plugin/marketplace.json", component: "conflicting-manifests" });
});

it("Claude catalog-added custom directory augments its manifest without bypassing component blocking", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./plugins/claude", skills: ["./entry-skills"] }] }, {
    "plugins/claude/.claude-plugin/plugin.json": { name: "bundle", skills: "./manifest-skills" },
    "plugins/claude/entry-skills/custom/SKILL.md": text, "plugins/claude/manifest-skills/other/SKILL.md": text });
  expect(await f.selected("plugins/claude/entry-skills/custom")).toMatchObject({ declaration: "verified", compatibilityFormat: "claude" });
});

it("Claude standard hooks are blocked even when no manifest is present", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./plugins/claude" }] }, { "plugins/claude/skills/text/SKILL.md": text, "plugins/claude/hooks/hooks.json": { hooks: {} } });
  const skill = await f.selected("plugins/claude/skills/text");
  expect(skill.blockers).toContain("DEPENDENCY_BLOCKED");
  expect(skill.dependencyIssues).toContainEqual({ kind: "component", path: "plugins/claude/hooks/hooks.json", component: "hooks" });
});

it("manifest skill traversal remains rejected without fetching another resource", async () => {
  const f = fixture("anthropic", { plugins: [{ name: "bundle", source: "./plugins/claude" }] }, { "plugins/claude/.claude-plugin/plugin.json": { name: "bundle", skills: "../outside" }, "plugins/claude/skills/text/SKILL.md": text });
  await expect(f.selected("plugins/claude/skills/text")).rejects.toMatchObject({ code: "PATH_INVALID" });
});

it("full review retains Remotion-shaped executable attachments and explains unsupported files and required runtime", async () => {
  const root = "plugins/bundle/skills/text";
  const f = fixture("openai", openaiCatalog, { "plugins/bundle/.codex-plugin/plugin.json": { name: "bundle", skills: "./skills", license: "MIT" },
    [root + "/SKILL.md"]: text + "\nYou must use the Remotion runtime tool and run scripts/render.mjs.\n",
    [root + "/LICENSE"]: createExternalFixture().expectedFiles.LICENSE,
    [root + "/scripts/render.mjs"]: "throw new Error('this candidate must never execute');\n" });
  const declared = await f.selected(root), payload = new Map([...f.payload].filter(([path]) => path.startsWith(root + "/")));
  const files = [...payload].map(([path, bytes]) => ({ path, bytes: bytes.length, blobSha1: gitSha(bytes), sha256: sha256(bytes) }));
  const reviewed = evaluateExternalSkill({ ...declared, files }, payload, []);
  expect(reviewed.blockers).toEqual(expect.arrayContaining(["DEPENDENCY_BLOCKED", "REVIEW_REQUIRED"]));
  expect(reviewed.dependencyIssues).toEqual(expect.arrayContaining([{ kind: "file", path: root + "/scripts/render.mjs" }, { kind: "instruction", path: root + "/SKILL.md", component: "tool-or-runtime" }]));
  expect(reviewed.files).toHaveLength(3); expect(payload.get(root + "/scripts/render.mjs")?.toString()).toContain("must never execute");
});
