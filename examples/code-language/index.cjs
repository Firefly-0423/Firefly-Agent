"use strict";

// Pure computation through the public Plugin API v1. No runtime SDK dependency.
// The extension tables below are copied from deepseek-harness packages/util/code-language/src/index.ts
// (MIT, Copyright (c) 2026 DeepSeek; upstream commit 86a402200d95fecef4529d969836f1fe13c6cb0d) and kept
// in the same order. The lookup logic is a plain JavaScript port of languageForPath and readLangHintForPath.
const TOOL_ID = "code-language_detect";
const MAX_PATHS = 200;
const MAX_PATH_CHARS = 1024;
let activeContext;

/** Recognized lowercase extensions (without the dot) per canonical language id; the id names the grammar. */
const LANGUAGE_EXTENSIONS = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'],
  csv: ['csv'],
  python: ['py', 'pyw', 'pyi'],
  ruby: ['rb', 'rake', 'gemspec'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['cs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini', 'conf', 'cfg', 'properties'],
  dotenv: ['env'],
  log: ['log'],
  diff: ['diff', 'patch'],
  http: ['http'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  rst: ['rst'],
  latex: ['tex', 'sty', 'cls'],
  bibtex: ['bib'],
  asciidoc: ['adoc'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg'],
  lua: ['lua'],
  bat: ['bat', 'cmd'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  julia: ['jl'],
  dart: ['dart'],
  scala: ['scala'],
  clojure: ['clj', 'cljs', 'edn'],
  erlang: ['erl', 'hrl'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  vb: ['vb'],
  perl: ['pl', 'pm'],
  verilog: ['v'],
  'system-verilog': ['sv', 'svh'],
  graphql: ['graphql', 'gql'],
  proto: ['proto'],
  hcl: ['tf', 'tfvars', 'hcl'],
  nix: ['nix'],
  vue: ['vue'],
  svelte: ['svelte'],
  make: ['makefile', 'mk'],
  cmake: ['cmake'],
  groovy: ['gradle', 'groovy'],
};

/** Extension to canonical language id. A Map, so "foo.constructor" and "foo.__proto__" miss instead of reaching Object.prototype. */
const LANGUAGES = new Map(Object.entries(LANGUAGE_EXTENSIONS)
  .flatMap(([language, extensions]) => extensions.map(extension => [extension, language])));

/** Suffixes whose own name is a better short label than their language's. */
const READ_LANG_BY_EXTENSION = new Map([
  ['tsx', 'tsx'], ['jsx', 'jsx'],
  ['tf', 'tf'], ['tfvars', 'tfvars'], ['gradle', 'gradle'],
]);

/** Short name per canonical language id. Keys are the ids above, never untrusted extensions. */
const SHORT_BY_LANGUAGE = {
  typescript: 'ts',
  javascript: 'js',
  shellscript: 'sh',
  fish: 'fish',
  json: 'json',
  csv: 'csv',
  python: 'py',
  ruby: 'rb',
  go: 'go',
  rust: 'rs',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  kotlin: 'kotlin',
  swift: 'swift',
  php: 'php',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  dotenv: 'env',
  log: 'log',
  diff: 'diff',
  http: 'http',
  markdown: 'md',
  mdx: 'mdx',
  rst: 'rst',
  latex: 'tex',
  bibtex: 'bib',
  asciidoc: 'adoc',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml',
  lua: 'lua',
  bat: 'bat',
  powershell: 'ps1',
  r: 'r',
  julia: 'jl',
  dart: 'dart',
  scala: 'scala',
  clojure: 'clj',
  erlang: 'erl',
  elixir: 'ex',
  haskell: 'hs',
  fsharp: 'fs',
  vb: 'vb',
  perl: 'pl',
  verilog: 'v',
  'system-verilog': 'sv',
  graphql: 'graphql',
  proto: 'proto',
  hcl: 'hcl',
  nix: 'nix',
  vue: 'vue',
  svelte: 'svelte',
  make: 'make',
  cmake: 'cmake',
  groovy: 'groovy',
};

function extensionForPath(path) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase();
}

function detect(path) {
  const extension = extensionForPath(path);
  const language = extension === undefined ? undefined : LANGUAGES.get(extension);
  if (language === undefined) return { path, language: null, shortName: null };
  return { path, language, shortName: READ_LANG_BY_EXTENSION.get(extension) ?? SHORT_BY_LANGUAGE[language] };
}

module.exports = {
  register(ctx) {
    if (activeContext) throw new Error("Code language is already registered");
    ctx.registerTool({
      id: TOOL_ID,
      name: "代码语言识别",
      description: `按文件扩展名识别源码、配置、脚本和标记文件的语法高亮语言，一次最多 ${MAX_PATHS} 个路径。不区分大小写，同时识别 / 和 \\ 分隔符；.env 识别为 dotenv，无扩展名的文件（Makefile、Dockerfile）和未收录的扩展名返回 null。只看文件名，不读取文件内容。`,
      enabled: true,
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: `文件名或路径列表，1 到 ${MAX_PATHS} 项，每项最多 ${MAX_PATH_CHARS} 个字符` },
        },
        required: ["paths"],
      },
      async execute(args) {
        if (!args || !Array.isArray(args.paths) || args.paths.some(path => typeof path !== "string")) throw new TypeError("paths must be an array of strings");
        if (args.paths.length < 1 || args.paths.length > MAX_PATHS) throw new RangeError(`paths must contain between 1 and ${MAX_PATHS} items`);
        if (args.paths.some(path => path.length > MAX_PATH_CHARS)) throw new RangeError(`each path must be at most ${MAX_PATH_CHARS} characters`);
        return JSON.stringify({ results: args.paths.map(detect) });
      },
    });
    activeContext = ctx;
  },
  unregister() {
    if (!activeContext) return;
    const ctx = activeContext;
    activeContext = undefined;
    ctx.unregisterTool(TOOL_ID);
  },
};
