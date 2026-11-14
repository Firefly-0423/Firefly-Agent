import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 日志出口检查：src/main 的生产代码不得直接调用 console.log / console.info / console.debug，
 * 要用 base/logging/logger 的 logger 加 LogTag，这样输出才会进主日志文件并受日志级别控制。
 * console.warn / console.error 暂不限制。
 *
 * 例外只有 features/diagnostics/**：诊断与模拟工具，输出本来就是给终端看的。
 * 不要为了过测试往例外里加别的目录；改用 logger。
 */
const mainRoot = __dirname;
const codeExtensions = [".ts", ".tsx", ".js", ".cjs", ".mjs"];
const bannedMethods = new Set(["log", "info", "debug"]);
const exemptPrefixes = ["features/diagnostics/"];

const isTestFile = (file: string) =>
  /\.(test|acceptance)\.[a-z]+$/.test(file) || /\.test-support\./.test(file) || /[\/](fixtures|testing|test-utils|test-support)[\/]/.test(file);

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (codeExtensions.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** 返回源码里 console.log / console.info / console.debug 调用所在的行号（从 1 开始）。 */
function findConsoleCalls(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let method: string | undefined;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") method = callee.name.text;
      else if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console"
        && ts.isStringLiteralLike(callee.argumentExpression)) method = callee.argumentExpression.text;
      if (method !== undefined && bannedMethods.has(method)) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("console usage detector", () => {
  it("finds direct log, info and debug calls", () => {
    const text = ["console.log(1);", "console.info('a');", "console['debug']('b');", "function f() {", "  console.log(2);", "}"].join("\n");
    expect(findConsoleCalls("sample.ts", text)).toEqual([1, 2, 3, 5]);
  });

  it("ignores warn, error, logger calls and text that only mentions console.log", () => {
    const text = ["console.warn('a');", "console.error('b');", "logger.info('Tag', 'c');", "const doc = \"console.log($$$ARGS)\";", "// console.log('commented')"].join("\n");
    expect(findConsoleCalls("sample.ts", text)).toEqual([]);
  });
});

describe("main process logging", () => {
  it("routes production output through logger instead of console.log, console.info or console.debug", () => {
    const found: string[] = [];
    for (const file of listFiles(mainRoot)) {
      if (isTestFile(file)) continue;
      const rel = path.relative(mainRoot, file).split(path.sep).join("/");
      if (exemptPrefixes.some((prefix) => rel.startsWith(prefix))) continue;
      for (const line of findConsoleCalls(file, fs.readFileSync(file, "utf8"))) found.push(`${rel}:${line}`);
    }
    expect(found).toEqual([]);
  });
});
