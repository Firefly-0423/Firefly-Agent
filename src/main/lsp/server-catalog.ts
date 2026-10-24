import path from "node:path";
import type { LspServerDefinition, LspServerOverride } from "./types";

type CatalogRow = [id: string, extensions: string[], command: string, args: string[], rootMarkers: string[], installHint: string];
const rows: CatalogRow[] = [
  ["typescript-language-server",[".ts",".tsx",".js",".jsx",".mjs",".cjs",".json",".jsonc"],"typescript-language-server",["--stdio"],["tsconfig.json","jsconfig.json","package.json",".git"],"安装 typescript-language-server 与 typescript，并确保 typescript-language-server 位于 PATH。"],
  ["python-pyright",[".py",".pyi"],"pyright-langserver",["--stdio"],["pyproject.toml","requirements.txt","setup.py",".git"],"安装 pyright，并确保 pyright-langserver 位于 PATH。"],
  ["gopls",[".go"],"gopls",[],["go.mod",".git"],"安装 gopls，并确保 gopls 位于 PATH。"],
  ["rust-analyzer",[".rs"],"rust-analyzer",[],["Cargo.toml",".git"],"安装 rust-analyzer，并确保 rust-analyzer 位于 PATH。"],
  ["clangd",[".c",".h",".cc",".cp",".cpp",".cxx",".hpp",".hh",".hxx"],"clangd",[],["compile_commands.json","CMakeLists.txt",".git"],"安装 clangd，并确保 clangd 位于 PATH。"],
  ["jdtls",[".java"],"jdtls",[],["pom.xml","build.gradle","settings.gradle",".git"],"安装 Eclipse JDT Language Server，并确保 jdtls 位于 PATH。"],
  ["omnisharp",[".cs",".csx"],"OmniSharp",["-lsp"],["*.sln","*.csproj",".git"],"安装 OmniSharp，并确保 OmniSharp 位于 PATH。"],
  ["intelephense",[".php"],"intelephense",["--stdio"],["composer.json",".git"],"安装 intelephense，并确保 intelephense 位于 PATH。"],
  ["ruby-lsp",[".rb",".rake",".gemspec"],"ruby-lsp",[],["Gemfile",".ruby-version",".git"],"安装 ruby-lsp，并确保 ruby-lsp 位于 PATH。"],
  ["kotlin-language-server",[".kt",".kts"],"kotlin-language-server",[],["build.gradle","settings.gradle",".git"],"安装 kotlin-language-server，并确保它位于 PATH。"],
  ["lua-language-server",[".lua"],"lua-language-server",[],[".luarc.json",".git"],"安装 lua-language-server，并确保它位于 PATH。"],
  ["vue-language-server",[".vue"],"vue-language-server",["--stdio"],["package.json","vite.config.ts",".git"],"安装 @vue/language-server，并确保 vue-language-server 位于 PATH。"],
  ["yaml-language-server",[".yaml",".yml"],"yaml-language-server",["--stdio"],[".git"],"安装 yaml-language-server，并确保它位于 PATH。"],
];
export const BUILTIN_LSP_SERVERS: readonly LspServerDefinition[] = rows.map(([id, extensions, command, args, rootMarkers, installHint]) => ({
  id, extensions, commands: [{ command, args }], rootMarkers, installHint,
}));

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const textValue = (item: unknown): item is string => typeof item === "string" && item.trim().length > 0;
const extensionValue = (item: unknown): item is string => textValue(item) && item.startsWith(".");

function jsonValue(item: unknown): boolean {
  if (item === null || typeof item === "boolean" || typeof item === "string") return true;
  if (typeof item === "number") return Number.isFinite(item);
  if (typeof item !== "object") return false;
  if (Array.isArray(item)) return item.every(jsonValue);
  return Object.entries(item as Record<string, unknown>).every(([key, nested]) => !forbiddenKeys.has(key) && jsonValue(nested));
}

function parseEntry(item: unknown, supported: ReadonlySet<string>, used: ReadonlySet<string>): LspServerOverride | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const identifier = record.id;
  if (!textValue(identifier) || !supported.has(identifier) || used.has(identifier)) return null;
  const override: LspServerOverride = { id: identifier };
  if (record.command !== undefined) {
    if (!textValue(record.command)) return null;
    override.command = record.command.trim();
  }
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || !record.args.every(textValue)) return null;
    override.args = record.args.map((argument) => argument.trim());
  }
  if (record.extensions !== undefined) {
    if (!Array.isArray(record.extensions) || !record.extensions.every(extensionValue)) return null;
    override.extensions = record.extensions.map((suffix) => suffix.trim().toLowerCase());
  }
  if (record.initializationOptions !== undefined && jsonValue(record.initializationOptions)) override.initializationOptions = record.initializationOptions;
  return override;
}

export function normalizeLspServerOverrides(input: unknown): LspServerOverride[] {
  if (!Array.isArray(input)) return [];
  const supported = new Set(BUILTIN_LSP_SERVERS.map((server) => server.id));
  const used = new Set<string>();
  const overrides: LspServerOverride[] = [];
  for (const item of input) {
    const override = parseEntry(item, supported, used);
    if (!override) continue;
    used.add(override.id);
    overrides.push(override);
  }
  return overrides;
}

function applyOverride(server: LspServerDefinition, overrides: readonly LspServerOverride[]): LspServerDefinition {
  const replacement = overrides.find((override) => {
    if (override.id !== server.id) return false;
    if (override.command && !textValue(override.command)) return false;
    if (override.args && !override.args.every(textValue)) return false;
    if (override.extensions && !override.extensions.every(extensionValue)) return false;
    return true;
  });
  if (!replacement) return server;
  const configured: LspServerDefinition = { ...server };
  if (replacement.extensions) configured.extensions = [...replacement.extensions];
  if (replacement.command) configured.commands = [{ command: replacement.command, args: replacement.args ? [...replacement.args] : [] }];
  if (replacement.initializationOptions !== undefined) configured.initializationOptions = replacement.initializationOptions;
  return configured;
}

export function findServerCandidates(filePath: string, overrides: readonly LspServerOverride[] = []): LspServerDefinition[] {
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === "") return [];
  return BUILTIN_LSP_SERVERS.filter((server) => server.extensions.includes(suffix)).map((server) => applyOverride(server, overrides));
}
