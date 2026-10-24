import assert from "node:assert/strict";
import test from "node:test";
import { sandboxTools } from "./plugin-fixture.mjs";

async function detect(paths) {
  const { call } = await sandboxTools("code-language");
  return (await call("code-language_detect", { paths })).results;
}

test("maps paths to the grammar id and the short name, case-insensitively and across both separators", async () => {
  assert.deepEqual(await detect(["src/app.ts", "C:\\dir\\main.PS1", "Docs/README.MD", "web/App.tsx", "infra/main.tf", "build.gradle"]), [
    { path: "src/app.ts", language: "typescript", shortName: "ts" },
    { path: "C:\\dir\\main.PS1", language: "powershell", shortName: "ps1" },
    { path: "Docs/README.MD", language: "markdown", shortName: "md" },
    { path: "web/App.tsx", language: "typescript", shortName: "tsx" },
    { path: "infra/main.tf", language: "hcl", shortName: "tf" },
    { path: "build.gradle", language: "groovy", shortName: "gradle" },
  ]);
});

test("follows the documented edge cases of the upstream table", async () => {
  const results = await detect([".env", ".gitignore", "Makefile", "foo.makefile", "archive.", "noext", "dir.v1/noext", "foo.constructor", "foo.__proto__", "a.toString", "cert.pem", "package.lock", "data.CSV", "x.sv", "x.cjs"]);
  const byPath = Object.fromEntries(results.map(item => [item.path, item.language]));
  assert.deepEqual(byPath, {
    ".env": "dotenv", ".gitignore": null, Makefile: null, "foo.makefile": "make", "archive.": null, noext: null, "dir.v1/noext": null,
    "foo.constructor": null, "foo.__proto__": null, "a.toString": null, "cert.pem": null, "package.lock": null,
    "data.CSV": "csv", "x.sv": "system-verilog", "x.cjs": "javascript",
  });
  assert.deepEqual(results.find(item => item.path === ".gitignore"), { path: ".gitignore", language: null, shortName: null });
  assert.equal(results.find(item => item.path === "x.sv").shortName, "sv");
});

test("every recognized extension resolves and every language has a short name", async () => {
  const { tools } = await sandboxTools("code-language");
  const schema = tools.get("code-language_detect").inputSchema;
  assert.equal(schema.properties.paths.type, "array");
  assert.equal(schema.properties.paths.items.type, "string");
  const sample = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "sh", "bash", "zsh", "fish", "json", "jsonc", "jsonl", "ndjson", "ipynb", "csv", "py", "pyw", "pyi", "rb", "rake", "gemspec", "go", "rs", "java", "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "cs", "kt", "kts", "swift", "php", "yaml", "yml", "toml", "ini", "conf", "cfg", "properties", "env", "log", "diff", "patch", "http", "md", "markdown", "mdx", "rst", "tex", "sty", "cls", "bib", "adoc", "html", "htm", "xhtml", "css", "scss", "less", "sql", "xml", "xsd", "xsl", "xslt", "plist", "svg", "lua", "bat", "cmd", "ps1", "psm1", "psd1", "r", "jl", "dart", "scala", "clj", "cljs", "edn", "erl", "hrl", "ex", "exs", "hs", "fs", "fsi", "fsx", "vb", "pl", "pm", "v", "sv", "svh", "graphql", "gql", "proto", "tf", "tfvars", "hcl", "nix", "vue", "svelte", "makefile", "mk", "cmake", "gradle", "groovy"];
  assert.equal(sample.length, 115, "keep this list in step with the upstream extension table");
  const results = await detect(sample.map(extension => `file.${extension}`));
  for (const item of results) {
    assert.equal(typeof item.language, "string", item.path);
    assert.equal(typeof item.shortName, "string", item.path);
  }
  assert.equal(new Set(results.map(item => item.language)).size, 61);
});

test("accepts only a bounded array of strings", async () => {
  const { tools } = await sandboxTools("code-language");
  const run = args => tools.get("code-language_detect").execute(args);
  for (const args of [{}, { paths: "a.ts" }, { paths: [1] }, { paths: ["a.ts", null] }, null, undefined]) {
    await assert.rejects(run(args), /paths must be an array of strings/);
  }
  await assert.rejects(run({ paths: [] }), /between 1 and 200/);
  await assert.rejects(run({ paths: Array(201).fill("a.ts") }), /between 1 and 200/);
  await assert.rejects(run({ paths: ["a".repeat(1025) + ".ts"] }), /at most 1024 characters/);
  assert.equal(JSON.parse(await run({ paths: Array(200).fill("a.ts") })).results.length, 200);
});
