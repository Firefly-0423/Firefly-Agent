import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES, externalSkillId } from "./external-policy";
import type { ExternalSkillSourceId } from "../../shared/external-skills";
import type { ExternalFetcher } from "./external-fetch";
const sourceModules = import.meta.glob<typeof import("./external-sources")>("./external-sources.ts");
const fetchModules = import.meta.glob<typeof import("./external-fetch")>("./external-fetch.ts");
async function implementation() {
  const load = sourceModules["./external-sources.ts"], fetchLoad = fetchModules["./external-fetch.ts"];
  expect(load, "Main must expand real upstream catalog formats").toBeTypeOf("function");
  expect(fetchLoad).toBeTypeOf("function");
  return { ...await load(), ...await fetchLoad() };
}
const commit = "a".repeat(40), treeSha = "b".repeat(40);
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const instruction = "---\nname: text\ndescription: Synthetic instruction\n---\nSummarize supplied text.\n";
function fixture(sourceId: ExternalSkillSourceId, catalog: unknown, otherFiles: Record<string, unknown> = {}) {
  const files = { [EXTERNAL_SOURCES[sourceId].catalogPath]: catalog, ...otherFiles };
  const bytes = Object.fromEntries(Object.entries(files).map(([path, value]) => [path, Buffer.from(typeof value === "string" ? value : JSON.stringify(value))]));
  const blobs = new Map(Object.values(bytes).map(value => [blobSha(value), value]));
  const entries = Object.entries(bytes).map(([path, value]) => ({ path, mode: "100644", type: "blob", sha: blobSha(value), size: value.length }));
  const calls: string[] = [], base = `https://api.github.com/repos/${EXTERNAL_SOURCES[sourceId].repository}`;
  const fetch: typeof globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url === base) return Response.json({ default_branch: "main" });
    if (url === base + "/commits/main") return Response.json({ sha: commit });
    if (url === base + "/git/commits/" + commit) return Response.json({ sha: commit, tree: { sha: treeSha } });
    if (url === base + "/git/trees/" + treeSha + "?recursive=1") return Response.json({ sha: treeSha, truncated: false, tree: entries });
    const value = blobs.get(url.slice((base + "/git/blobs/").length));
    if (url.startsWith(base + "/git/blobs/") && value) return Response.json({ sha: blobSha(value), size: value.length, encoding: "base64", content: value.toString("base64") });
    throw new Error("Unexpected mock route");
  };
  return { fetch, calls, tree: { commit, entries } as import("./external-fetch").ExternalTree };
}
async function expandAndVerify(mock: ReturnType<typeof fixture>) {
  const { discoverExternalSkills, createExternalFetcher, verifyExternalSkillDeclaration } = await implementation();
  const fetcher = createExternalFetcher(mock.fetch), declarations = new Map<string, string>();
  const listed = await discoverExternalSkills("openai", fetcher, new AbortController().signal, declarations);
  const verified = await Promise.all(listed.map(skill => verifyExternalSkillDeclaration(skill, declarations.get(skill.id)!, mock.tree, fetcher, new AbortController().signal)));
  return { listed, verified };
}

const anthropic = (skills: string[]) => ({ name: "synthetic-anthropic", metadata: { version: "9.0.0" }, plugins: [{ name: "text-bundle", source: "./", description: "Synthetic bundle", skills }] });
const openai = (plugins: unknown[]) => ({ name: "synthetic-openai", plugins });
const local = { name: "text-bundle", source: { source: "local", path: "./plugins/text-bundle" } };
afterEach(() => vi.useRealTimers());

describe("real_source_adapters", () => {
  it("resolves Anthropic skills[] from repository root and keeps bundle version separate", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation();
    const mock = fixture("anthropic", anthropic(["./skills/text"]), { "skills/text/SKILL.md": instruction });
    const result = await discoverExternalSkills("anthropic", createExternalFetcher(mock.fetch), new AbortController().signal);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: externalSkillId("anthropic", "anthropics/skills", "skills/text"), sourceId: "anthropic", path: "skills/text", upstreamName: "text", repository: "anthropics/skills", commit, bundle: { name: "text-bundle", version: "9.0.0" }, review: "unreviewed", blockers: ["REVIEW_REQUIRED"] });
    expect(result[0].version).toBeUndefined();
  });
  it("verifies OpenAI actual manifest skills directory on selection and blocks the undeclared decoy", async () => {
    const mock = fixture("openai", openai([local]), { "plugins/text-bundle/.codex-plugin/plugin.json": { name: "text-bundle", version: "2.0.0", license: "Proprietary", description: "Synthetic manifest", skills: "./instruction-set/" }, "plugins/text-bundle/instruction-set/text/SKILL.md": instruction, "plugins/text-bundle/skills/decoy/SKILL.md": instruction });
    const { listed, verified } = await expandAndVerify(mock);
    expect(listed).toHaveLength(2); expect(listed.every(skill => skill.declaration === "pending")).toBe(true);
    const accepted = verified.filter(skill => skill.declaration === "verified");
    expect(accepted.map(skill => skill.path)).toEqual(["plugins/text-bundle/instruction-set/text"]);
    expect(accepted[0].bundle).toEqual({ name: "text-bundle", version: "2.0.0", license: "Proprietary" }); expect(accepted[0].version).toBeUndefined();
    expect(verified.find(skill => skill.path.endsWith("/decoy"))).toMatchObject({ declaration: "blocked", review: "blocked", blockers: ["DEPENDENCY_BLOCKED"] });
  });
  it("retains URL/git-subdir entries as explicitly informational-only without other repository requests", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation();
    const mock = fixture("openai", openai([{ name: "url-entry", source: { source: "url", url: "https://example.invalid/plugin" } }, { name: "git-entry", source: { source: "git-subdir", url: "https://github.com/third-party/repo.git", path: "plugins/text", ref: "main" } }]));
    const result = await discoverExternalSkills("openai", createExternalFetcher(mock.fetch), new AbortController().signal);
    expect(result).toHaveLength(2);
    for (const skill of result) { expect(skill.review).toBe("blocked"); expect(skill.blockers).toEqual(["DEPENDENCY_BLOCKED"]); expect(skill.description).toMatch(/informational.only.*no.import/i); expect(skill.path).toMatch(/^catalog-entry\//); }
    const callsToOtherRepositories = mock.calls.filter(url => !url.startsWith("https://api.github.com/repos/openai/plugins/" ) && url !== "https://api.github.com/repos/openai/plugins");
    expect(callsToOtherRepositories).toEqual([]);
  });
  it.each(["bad-source", "toString"])("rejects unknown source %s explicitly", async sourceId => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("openai", openai([]));
    await expect(discoverExternalSkills(sourceId as "openai", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "SOURCE_INVALID" }); expect(mock.calls).toHaveLength(0);
  });
  it.each(["{", { plugins: {} }, { plugins: [{ name: "x", source: { source: "unsupported" } }] }])("rejects malformed or unknown catalog rather than succeeding empty %j", async catalog => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("openai", catalog);
    await expect(discoverExternalSkills("openai", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
  });
  it("a valid empty catalog produces no latest candidates or import authority", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("openai", { plugins: [] });
    expect(await discoverExternalSkills("openai", createExternalFetcher(mock.fetch), new AbortController().signal)).toEqual([]);
  });
  it("selection rejects malformed manifest and blocks a missing or nonmatching declaration", async () => {
    for (const manifest of ["{", { name: "text-bundle", skills: 10 }]) {
      const mock = fixture("openai", openai([local]), { "plugins/text-bundle/.codex-plugin/plugin.json": manifest, "plugins/text-bundle/skills/text/SKILL.md": instruction });
      await expect(expandAndVerify(mock)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
    }
    for (const manifest of [{ name: "text-bundle" }, { name: "text-bundle", skills: "./missing/" }]) {
      const mock = fixture("openai", openai([local]), { "plugins/text-bundle/.codex-plugin/plugin.json": manifest, "plugins/text-bundle/skills/text/SKILL.md": instruction });
      expect((await expandAndVerify(mock)).verified[0]).toMatchObject({ declaration: "blocked", review: "blocked" });
    }
    const missing = fixture("openai", openai([local]), { "plugins/text-bundle/skills/text/SKILL.md": instruction });
    await expect(expandAndVerify(missing)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
  });
  it("rejects missing catalog, manifest and SKILL.md explicitly", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation();
    for (const [sourceId, catalog] of [["openai", openai([local])], ["anthropic", anthropic(["./skills/missing"])]] as const) {
      const mock = fixture(sourceId, catalog); await expect(discoverExternalSkills(sourceId, createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
    }
    const fetcher: ExternalFetcher = { resolveCommit: async () => commit, readTree: async () => ({ commit, entries: [] }), readBlob: async () => Buffer.from("{}") };
    await expect(discoverExternalSkills("openai", fetcher, new AbortController().signal)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
  });
  it("rejects duplicate stable candidate IDs", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("anthropic", anthropic(["./skills/text", "./skills/text"]), { "skills/text/SKILL.md": instruction });
    await expect(discoverExternalSkills("anthropic", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
  });
  it.each(["/absolute", "./../escape", "./skills/../escape", "./skills%2ftext", "./skills\\text", "./skills/CON", "https://user@host/skill", "./skills/text#fragment"])("rejects candidate path %s without arbitrary fetches", async path => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("anthropic", anthropic([path]));
    await expect(discoverExternalSkills("anthropic", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "PATH_INVALID" });
  });
  it.each([2000, 2001])("enforces expanded candidate count %i", async count => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const paths = Array.from({ length: count }, (_, i) => `./skills/f${i}`);
    const files = Object.fromEntries(paths.map(path => [path.slice(2) + "/SKILL.md", instruction])); const mock = fixture("anthropic", anthropic(paths), files);
    const promise = discoverExternalSkills("anthropic", createExternalFetcher(mock.fetch), new AbortController().signal);
    if (count === 2000) expect(await promise).toHaveLength(count); else await expect(promise).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("enforces one fixed two-minute discovery deadline even for an ignoring injected fetcher", async () => {
    const { discoverExternalSkills } = await implementation(); vi.useFakeTimers(); let received: AbortSignal | undefined;
    const fetcher: ExternalFetcher = { resolveCommit: async (_id, signal) => { received = signal; return new Promise<string>(() => {}); }, readTree: async () => ({ commit, entries: [] }), readBlob: async () => Buffer.from("{}") };
    const promise = discoverExternalSkills("openai", fetcher, new AbortController().signal); const assertion = expect(promise).rejects.toMatchObject({ code: "PREPARE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(EXTERNAL_LIMITS.prepareMs - 1); expect(received?.aborted).toBe(false); await vi.advanceTimersByTimeAsync(1); await assertion; expect(received?.aborted).toBe(true);
  });
  it("rejects catalog byte limit before adapter parsing", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("anthropic", " ".repeat(EXTERNAL_LIMITS.catalogBytes + 1));
    await expect(discoverExternalSkills("anthropic", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

describe("source_metadata_and_fanout_guards", () => {
  it.each(["./../escape", "./skills%2ftext", "./skills\\text", "https://untrusted.example/skills", "./skills/CON"])("rejects unsafe OpenAI manifest skills root %s", async skills => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation();
    const mock = fixture("openai", openai([local]), { "plugins/text-bundle/.codex-plugin/plugin.json": { name: "text-bundle", skills }, "plugins/text-bundle/skills/text/SKILL.md": instruction });
    await expect(expandAndVerify(mock)).rejects.toMatchObject({ code: "PATH_INVALID" });
  });
  it.each([{}, { source: "url", url: "http://untrusted.example/plugin" }, { source: "url", url: "https://user@host/plugin" }, { source: "url", url: "https://host/plugin#fragment" }, { source: "url", url: "https://host/a%2fb" }, { source: "git-subdir", url: "https://host/repo", path: "../outside" }])("rejects malformed external entry metadata %j", async source => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation(); const mock = fixture("openai", openai([{ name: "external", source }]));
    await expect(discoverExternalSkills("openai", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
    expect(mock.calls).toHaveLength(5);
  });
  it("OpenAI list has no manifest fanout and skips bundles without any actual Skill body", async () => {
    const { discoverExternalSkills, createExternalFetcher } = await implementation();
    const plugins = Array.from({ length: 8 }, (_, i) => ({ name: `bundle-${i}`, source: { source: "local", path: `./plugins/bundle-${i}` } }));
    const files = Object.fromEntries(plugins.slice(0, 7).flatMap(({ name }) => [[`plugins/${name}/.codex-plugin/plugin.json`, { name, skills: "./skills/" }], [`plugins/${name}/skills/text/SKILL.md`, instruction]]));
    const mock = fixture("openai", openai(plugins), files); let active = 0, maximum = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!String(input).includes("/git/blobs/")) return mock.fetch(input, init);
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await mock.fetch(input, init); }
      finally { active--; }
    };
    expect(await discoverExternalSkills("openai", createExternalFetcher(fetch), new AbortController().signal)).toHaveLength(7);
    expect(maximum).toBe(1); expect(mock.calls).toHaveLength(5);
  });
  it("a selected manifest failure never starts sibling bundle reads", async () => {
    const { discoverExternalSkills, verifyExternalSkillDeclaration } = await implementation();
    const catalog = Buffer.from(JSON.stringify(openai(Array.from({ length: 8 }, (_, i) => ({ name: "bundle-" + i, source: { source: "local", path: "./plugins/bundle-" + i } })))));
    const entries = [{ path: EXTERNAL_SOURCES.openai.catalogPath, sha: "c".repeat(40), mode: "100644", type: "blob" as const, size: catalog.length }, ...Array.from({ length: 8 }, (_, i) => [{ path: "plugins/bundle-" + i + "/skills/text/SKILL.md", sha: "d".repeat(40), mode: "100644", type: "blob" as const, size: 1 }, { path: "plugins/bundle-" + i + "/.codex-plugin/plugin.json", sha: String(i).repeat(40), mode: "100644", type: "blob" as const, size: 1 }]).flat()];
    let calls = 0;
    const fetcher: ExternalFetcher = { resolveCommit: async () => commit, readTree: async () => ({ commit, entries }), readBlob: async (_id, hash) => { if (hash === "c".repeat(40)) return catalog; calls++; throw new Error("Synthetic manifest failure"); } };
    const declarations = new Map<string, string>(), selected = (await discoverExternalSkills("openai", fetcher, new AbortController().signal, declarations)).find(skill => skill.path.includes("/bundle-0/"))!;
    expect(calls).toBe(0);
    await expect(verifyExternalSkillDeclaration(selected, declarations.get(selected.id)!, { commit, entries }, fetcher, new AbortController().signal)).rejects.toMatchObject({ code: "NETWORK_FAILED", message: "External request failed." });
    expect(calls).toBe(1);
  });

});

it("rejects external URL dot-segment normalization instead of accepting an ambiguous path", async () => {
  const { discoverExternalSkills, createExternalFetcher } = await implementation();
  const mock = fixture("openai", openai([{ name: "external", source: { source: "url", url: "https://host/a/../outside" } }]));
  await expect(discoverExternalSkills("openai", createExternalFetcher(mock.fetch), new AbortController().signal)).rejects.toMatchObject({ code: "CATALOG_INVALID" });
});

it("lazy_declaration list reads only the pinned catalog and returns actual Skill paths without manifest guesses", async () => {
  const { discoverExternalSkills, createExternalFetcher } = await implementation();
  const mock = fixture("openai", openai([local]), { "plugins/text-bundle/.codex-plugin/plugin.json": { name: "text-bundle", skills: "./instruction-set/", license: "Proprietary", version: "9" }, "plugins/text-bundle/instruction-set/text/SKILL.md": instruction, "plugins/text-bundle/skills/decoy/SKILL.md": instruction });
  const declarations = new Map<string, string>();
  const listed = await discoverExternalSkills("openai", createExternalFetcher(mock.fetch), new AbortController().signal, declarations);
  expect(mock.calls).toHaveLength(5); expect(listed.map(item => item.path).sort()).toEqual(["plugins/text-bundle/instruction-set/text", "plugins/text-bundle/skills/decoy"]);
  for (const item of listed) { expect(item.declaration).toBe("pending"); expect(item.bundle).toEqual({ name: "text-bundle" }); expect(declarations.get(item.id)).toBe("plugins/text-bundle"); }
});
