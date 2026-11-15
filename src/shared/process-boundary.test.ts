import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 进程边界：渲染进程和 preload 的生产代码不得引用 src/main（类型引用也不行）。
 * 两边共用的类型放在 src/shared；渲染进程只经 preload 暴露的接口和主进程通信。
 */
const srcRoot = path.resolve(__dirname, "..");
const mainRoot = path.join(srcRoot, "main");
const codeExtensions = [".ts", ".tsx", ".js", ".cjs", ".mjs"];
const isTestFile = (file: string) => /\.(test|acceptance)\.[a-z]+$/.test(file) || /[\\/](fixtures|testing|test-utils|test-support)[\\/]/.test(file);

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (codeExtensions.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) found.push(node.arguments[0].text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function mainImports(processDir: string): string[] {
  const violations: string[] = [];
  for (const file of listFiles(path.join(srcRoot, processDir))) {
    if (isTestFile(file)) continue;
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (target === mainRoot || target.startsWith(mainRoot + path.sep)) {
        violations.push(`${path.relative(srcRoot, file).split(path.sep).join("/")} -> ${specifier}`);
      }
    }
  }
  return violations;
}

describe("process boundary", () => {
  it.each(["renderer", "preload"])("%s production code does not import src/main", (processDir) => {
    expect(mainImports(processDir)).toEqual([]);
  });
});
