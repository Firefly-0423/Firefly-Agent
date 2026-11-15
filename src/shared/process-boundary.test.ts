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

/** 解析一个相对导入实际指向的源文件；找不到时返回 undefined。 */
function resolveLocal(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base + ".ts", base + ".tsx", base.replace(/\.js$/, ".ts"), path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

const portable = (file: string) => path.relative(srcRoot, file).split(path.sep).join("/");
const inMain = (file: string) => file === mainRoot || file.startsWith(mainRoot + path.sep);

/**
 * 从某个进程目录的生产代码出发，沿相对导入一路追踪（经过 src/shared 也继续追），
 * 返回所有到达 src/main 或测试文件的导入。只查直接导入的话，经共享模块转一手就漏了。
 */
function reachableViolations(processDir: string): string[] {
  const start = listFiles(path.join(srcRoot, processDir)).filter((file) => !isTestFile(file));
  const seen = new Set(start);
  const queue = [...start];
  const violations: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveLocal(file, specifier) ?? path.resolve(path.dirname(file), specifier);
      if (inMain(target)) violations.push(`${portable(file)} -> ${specifier}`);
      // 测试辅助文件（*.test-support.* 等）只给测试用，生产代码引用它会把测试工具打进安装包。
      else if (isTestFile(target)) violations.push(`${portable(file)} -> ${specifier} (引用测试文件)`);
      else if (codeExtensions.includes(path.extname(target)) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return violations;
}

describe("test-only files stay out of the build", () => {
  // 按 TypeScript 实际解析出的编译清单检查，而不是只看 exclude 里写了哪些字符串。
  it.each(["tsconfig.main.json", "tsconfig.preload.json"])("%s compiles no test-only file", (configName) => {
    const repoRoot = path.join(srcRoot, "..");
    const read = ts.readConfigFile(path.join(repoRoot, configName), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
    expect(parsed.fileNames.length).toBeGreaterThan(0);
    expect(parsed.fileNames.filter(isTestFile).map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))).toEqual([]);
  });
});

describe("process boundary", () => {
  it.each(["renderer", "preload"])("%s production code reaches neither src/main nor test-only files, also through shared modules", (processDir) => {
    expect(reachableViolations(processDir)).toEqual([]);
  });
});
