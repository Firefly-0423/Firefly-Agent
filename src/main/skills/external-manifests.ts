import type { ExternalDependencyIssue, ExternalSkill } from "../../shared/external-skills";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES, isAllowedExternalLicense } from "./external-policy";
import { ExternalFetchError, parseExternalJson, validateExternalPath, type ExternalFetcher, type ExternalTree } from "./external-fetch";

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
function data(value: unknown): Data { if (!object(value)) throw new ExternalFetchError("CATALOG_INVALID"); return value; }
function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new ExternalFetchError("CATALOG_INVALID"); return value;
}
function optionalLabel(value: unknown): string | undefined { return value === undefined ? undefined : label(value); }
const join = (root: string, relative: string) => validateExternalPath((root ? root + "/" : "") + relative);
function skillDirectory(root: string, value: unknown): string {
  if (value === "." || value === "./") return root;
  if (typeof value !== "string" || !value.startsWith("./")) throw new ExternalFetchError("PATH_INVALID");
  return join(root, validateExternalPath(value.slice(2).replace(/\/$/, "")));
}
function roots(root: string, value: unknown): string[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || !items.length || items.length > EXTERNAL_LIMITS.candidates) throw new ExternalFetchError("CATALOG_INVALID");
  return items.map(item => skillDirectory(root, item));
}
const active = (value: unknown) => value !== undefined && (Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : true);
const components = new Set(["apps", "mcpServers", "hooks", "commands", "agents", "lspServers", "dependencies", "userConfig", "settings", "workflows", "channels", "outputStyles", "experimental", "themes", "monitors", "onboardingSkill"]);
const metadata = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "displayName", "metadata", "interface", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl", "defaultEnabled", "skills", "extensions"]);

class UnsupportedMetadataMode extends Error {
  constructor(readonly issues: readonly ExternalDependencyIssue[]) { super("DEPENDENCY_BLOCKED"); }
}

/** Passive format adaptation only. No entrypoint, lifecycle, MCP process or template is loaded. */
export async function inspectExternalManifest(skill: ExternalSkill, root: string, tree: ExternalTree, fetcher: ExternalFetcher, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<ExternalSkill> {
  try { return await inspectManifest(skill, root, tree, fetcher, signal, onBytes); }
  catch (error) {
    if (!(error instanceof UnsupportedMetadataMode)) throw error;
    return { ...skill, declaration: "blocked", review: "blocked",
      blockers: [...new Set([...skill.blockers, "DEPENDENCY_BLOCKED" as const])],
      dependencyIssues: error.issues.map(issue => ({ ...issue })) };
  }
}

async function inspectManifest(skill: ExternalSkill, root: string, tree: ExternalTree, fetcher: ExternalFetcher, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<ExternalSkill> {
  if (root !== "") validateExternalPath(root);
  if (skill.commit !== tree.commit || (root && skill.path !== root && !skill.path.startsWith(root + "/"))) throw new ExternalFetchError("TREE_INVALID");
  const byPath = new Map(tree.entries.map(entry => [entry.path, entry])), issues: ExternalDependencyIssue[] = [...(skill.dependencyIssues ?? [])];
  const declaredLicenses: string[] = [];
  const issue = (path: string, component: string, kind: ExternalDependencyIssue["kind"] = "component") => {
    if (issues.length < EXTERNAL_LIMITS.files && !issues.some(item => item.kind === kind && item.path === path && item.component === component)) issues.push({ kind, path, component });
  };
  async function readJson(path: string): Promise<Data> {
    if (signal.aborted) throw new ExternalFetchError("CANCELLED");
    const entry = byPath.get(path);
    if (!entry || entry.type !== "blob") throw new ExternalFetchError("CATALOG_INVALID");
    if (entry.mode !== "100644") throw new UnsupportedMetadataMode([
      { kind: "file-mode" as const, path }, ...issues.filter(issue => issue.kind !== "file-mode" || issue.path !== path),
    ].slice(0, EXTERNAL_LIMITS.files));
    if (entry.size !== undefined && entry.size > EXTERNAL_LIMITS.catalogBytes) throw new ExternalFetchError("LIMIT_EXCEEDED");
    const bytes = await fetcher.readBlob(skill.sourceId, entry.sha, EXTERNAL_LIMITS.catalogBytes, signal, "catalog"); onBytes(bytes.length);
    if (signal.aborted) throw new ExternalFetchError("CANCELLED");
    if (bytes.length > EXTERNAL_LIMITS.catalogBytes) throw new ExternalFetchError("LIMIT_EXCEEDED");
    if (entry.size !== undefined && bytes.length !== entry.size) throw new ExternalFetchError("BLOB_MISMATCH");
    return data(parseExternalJson(bytes));
  }
  function inspectFields(value: Data, path: string, strict = true): void {
    const license = optionalLabel(value.license); if (license !== undefined) declaredLicenses.push(license);
    for (const [key, entry] of Object.entries(value)) {
      if (components.has(key) && active(entry)) issue(path, key);
      else if (strict && !components.has(key) && !metadata.has(key)) issue(path, "unknown-manifest-field");
    }
  }
  function inspectOpenAIExtensions(value: Data, path: string): void {
    if (value.extensions === undefined) return;
    for (const [key, extension] of Object.entries(data(value.extensions))) {
      if (key === "com.openai") {
        const overlay = data(extension); inspectFields(overlay, path);
        if (active(overlay.extensions)) issue(path, "unknown-extension");
      } else if (active(extension)) issue(path, "unknown-extension");
    }
  }
  const portablePath = join(root, "plugin.json"), codexPath = join(root, ".codex-plugin/plugin.json"), claudePath = join(root, ".claude-plugin/plugin.json");
  const manifestPath = byPath.has(portablePath) ? portablePath : byPath.has(codexPath) ? codexPath : byPath.has(claudePath) ? claudePath : undefined;
  if (!manifestPath && skill.sourceId === "openai") throw new ExternalFetchError("CATALOG_INVALID");
  const manifest = manifestPath ? await readJson(manifestPath) : undefined;
  const format: NonNullable<ExternalSkill["compatibilityFormat"]> = manifestPath === portablePath ? "openai-portable" : manifestPath === codexPath ? "codex" : manifestPath === claudePath ? "claude" : "claude-catalog";
  let allowedRoots: string[] = [], entry: Data | undefined;
  if (skill.sourceId === "anthropic") {
    const catalogPath = EXTERNAL_SOURCES.anthropic.catalogPath, catalog = await readJson(catalogPath);
    if (!Array.isArray(catalog.plugins)) throw new ExternalFetchError("CATALOG_INVALID");
    const matches = catalog.plugins.filter(value => {
      const plugin = data(value);
      return plugin.name === skill.bundle.name && skillDirectory("", plugin.source) === root;
    });
    if (matches.length !== 1) throw new ExternalFetchError("CATALOG_INVALID");
    entry = data(matches[0]); inspectFields(entry, catalogPath, false);
    if (entry.skills !== undefined) allowedRoots.push(...roots(root, entry.skills));
    if (manifest && entry.strict === false && ["commands", "agents", "skills", "hooks", "outputStyles", "themes"].some(key => Object.hasOwn(entry!, key))) issue(catalogPath, "conflicting-manifests", "declaration");
  }
  const explicitRootSelection = root === "" && entry?.skills !== undefined;
  if (manifest) {
    label(manifest.name); inspectFields(manifest, manifestPath!);
    if (format === "openai-portable") {
      if (manifest.$schema !== undefined && manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") throw new ExternalFetchError("CATALOG_INVALID");
      allowedRoots = [join(root, "skills")];
      if (manifest.skills !== undefined) issue(manifestPath!, "custom-skills");
      const extensions = manifest.extensions === undefined ? {} : data(manifest.extensions);
      for (const key of Object.keys(extensions)) if (key !== "com.openai" && active(extensions[key])) issue(manifestPath!, "unknown-extension");
      let overlay: Data | undefined, overlayPath = manifestPath!;
      if (Object.hasOwn(extensions, "com.openai")) overlay = data(extensions["com.openai"]);
      else if (byPath.has(codexPath)) { overlay = await readJson(codexPath); overlayPath = codexPath; }
      if (overlay) {
        inspectFields(overlay, overlayPath);
        if (overlayPath === portablePath && active(overlay.extensions)) issue(overlayPath, "unknown-extension");
        else inspectOpenAIExtensions(overlay, overlayPath);
        if (overlay.skills !== undefined && roots(root, overlay.skills).some(path => path !== join(root, "skills"))) issue(overlayPath, "custom-skills");
      }
    } else {
      if (format === "codex") inspectOpenAIExtensions(manifest, manifestPath!);
      else if (manifest.extensions !== undefined && Object.values(data(manifest.extensions)).some(active)) issue(manifestPath!, "unknown-extension");
      if (format === "claude" && !explicitRootSelection) allowedRoots.push(join(root, "skills"));
      if (manifest.skills !== undefined) {
        const paths = roots(root, manifest.skills); if (!explicitRootSelection) allowedRoots.push(...paths);
      }
    }
  } else if (entry?.skills === undefined) allowedRoots.push(join(root, "skills"));
  // Claude's single-SKILL fallback is representable only for a nonempty package root.
  if ((format === "claude" || format === "claude-catalog") && root && !byPath.has(join(root, "skills")) &&
    !tree.entries.some(item => item.path.startsWith(join(root, "skills") + "/")) && manifest?.skills === undefined && entry?.skills === undefined && byPath.has(join(root, "SKILL.md"))) allowedRoots.push(root);
  const declared = allowedRoots.some(path => skill.path === path || (skill.path.startsWith(path ? path + "/" : "") && skill.path.slice(path ? path.length + 1 : 0).split("/").length === 1));
  for (const name of ["mcp.json", ".mcp.json"] as const) {
    const path = join(root, name); if (!byPath.has(path)) continue;
    const config = await readJson(path);
    if (!object(config.mcpServers) || Object.keys(config.mcpServers).length || Object.keys(config).some(key => key !== "$schema" && key !== "mcpServers")) issue(path, "mcp");
  }
  for (const [directory, component] of [["commands", "commands"], ["agents", "agents"], ["hooks", "hooks"], ["bin", "executables"], ["scripts", "scripts"], ["workflows", "workflows"], ["output-styles", "outputStyles"], ["themes", "themes"], ["monitors", "monitors"]]) {
    const prefix = join(root, directory) + "/", found = tree.entries.find(item => item.type === "blob" && item.path.startsWith(prefix));
    if (found) issue(found.path, component);
  }
  for (const [name, component] of [[".lsp.json", "lspServers"], ["settings.json", "settings"], ["CLAUDE.md", "host-instructions"], [".app.json", "apps"]]) {
    const path = join(root, name); if (byPath.has(path)) issue(path, component);
  }
  const name = manifest ? label(manifest.name) : skill.bundle.name;
  const version = optionalLabel(manifest?.version) ?? optionalLabel(entry?.version) ?? skill.bundle.version;
  const license = optionalLabel(entry?.license) ?? optionalLabel(manifest?.license) ?? skill.bundle.license;
  const description = optionalLabel(entry?.description) ?? optionalLabel(manifest?.description) ?? skill.description;
  const licenseBlocked = declaredLicenses.some(value => !isAllowedExternalLicense(value));
  if (!declared) issue(manifestPath ?? EXTERNAL_SOURCES[skill.sourceId].catalogPath, "skill-path", "declaration");
  const blockers = declared ? [...new Set([...skill.blockers, ...(issues.length ? ["DEPENDENCY_BLOCKED" as const] : [])])]
    : [...new Set([...skill.blockers.filter(code => code !== "REVIEW_REQUIRED"), "DEPENDENCY_BLOCKED" as const])];
  if (declared && licenseBlocked && !blockers.includes("LICENSE_BLOCKED")) blockers.push("LICENSE_BLOCKED");
  return { ...skill, bundle: { name, ...(version ? { version } : {}), ...(license ? { license } : {}) }, description,
    compatibilityFormat: format, dependencyIssues: issues, declaration: declared ? "verified" : "blocked",
    review: issues.length || licenseBlocked ? "blocked" : skill.review, blockers };
}
