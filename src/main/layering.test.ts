import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 依赖方向测试：src/main 的每个文件只能引用自己所在层和 layers.json 允许的层。
 * 过渡期的存量违规记在 layering-known-violations.json 里，这份清单只能减少：
 * 新增违规会失败；清单里已经修掉的条目也会失败，提醒把它从清单删除。
 */
const mainRoot = __dirname;
const layers = (JSON.parse(fs.readFileSync(path.join(mainRoot, "layers.json"), "utf8")) as {
  layers: Record<string, { level: number; allow: string[] }>;
}).layers;
const known = new Set(JSON.parse(fs.readFileSync(path.join(mainRoot, "layering-known-violations.json"), "utf8")) as string[]);

const codeExtensions = [".ts", ".tsx", ".js", ".cjs", ".mjs"];
const isTestFile = (file: string) =>
  /\.(test|acceptance)\.[a-z]+$/.test(file) || /\.test-support\./.test(file) || /[\\/](fixtures|testing|test-utils|test-support)[\\/]/.test(file);

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (codeExtensions.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(mainRoot, file).split(path.sep).join("/");
/** 直接放在 src/main 下的文件（index.ts 等入口）按组合根对待。 */
const layerOf = (rel: string) => (rel.includes("/") ? rel.split("/")[0] : "app");

function collectViolations(): string[] {
  const all = listFiles(mainRoot);
  const present = new Set(all.map((file) => path.normalize(file)));
  const resolve = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.normalize(path.resolve(path.dirname(from), specifier));
    const candidates = [base, ...codeExtensions.map((ext) => base + ext), ...codeExtensions.map((ext) => path.join(base, "index" + ext))];
    return candidates.find((candidate) => present.has(candidate));
  };
  const found = new Set<string>();
  for (const file of all) {
    if (isTestFile(file)) continue;
    const from = relative(file);
    const fromLayer = layerOf(from);
    const allowed = layers[fromLayer];
    if (!allowed) { found.add(`${from} -> (目录 ${fromLayer} 不在 layers.json 里)`); continue; }
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    const check = (specifier: string) => {
      const target = resolve(file, specifier);
      if (!target || isTestFile(target)) return;
      const to = relative(target);
      const toLayer = layerOf(to);
      if (toLayer !== fromLayer && !allowed.allow.includes(toLayer)) found.add(`${from} -> ${to}`);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        check(node.arguments[0].text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        check(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
}

describe("src/main layering", () => {
  const violations = collectViolations();

  it("has no import that goes up or sideways beyond what layers.json allows, except the recorded ones", () => {
    expect(violations.filter((entry) => !known.has(entry))).toEqual([]);
  });

  it("keeps the recorded violation list in step with the code: fixed entries are removed", () => {
    const current = new Set(violations);
    expect([...known].filter((entry) => !current.has(entry))).toEqual([]);
  });
});
