import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * IPC 契约的静态扫描：借助 TypeScript 语法树找出通道的注册与调用点。
 *
 * 只有“第一个实参是 `IPC.<KEY>`”的调用才算数，所以以下情况不会误报：
 *   - 注释里的示例代码
 *   - 字符串里恰好出现的通道名
 *   - 以形参传入的通道（如 `webContents.send(channel, payload)`），无法静态求值
 *
 * 与 `src/renderer/default-dialogs-scanner.ts` 沿用同一约定：
 * 输入 (file, source)，返回带文件名和行号的命中列表，无副作用。
 */

export type IpcChannelUseKind =
  /** 渲染端 `ipcRenderer.invoke`，需要主进程 handle 给出返回值。 */
  | "invoke"
  /** 渲染端 `ipcRenderer.send`，需要主进程 on 接收单向消息。 */
  | "send"
  /** 渲染端 `ipcRenderer.on/once/off/removeListener`，需要主进程外发。 */
  | "listen"
  /** 主进程 `handle` 或插件运行时 `registerIpc`，提供返回值。 */
  | "handle"
  /** 主进程 `ipcMain.on`，接收单向消息。 */
  | "on"
  /** 主进程外发：名字含 send / broadcast / emit / post 的函数。 */
  | "outbound";

export interface IpcChannelUse {
  kind: IpcChannelUseKind;
  /** IPC 常量表中的键，如 `WINDOW_MINIMIZE`。 */
  channel: string;
  /** 命中所在文件，原样取自传入的 file。 */
  file: string;
  /** 从 1 开始的行号。 */
  line: number;
}

const RENDERER_SENDERS = new Set(["send", "sendSync"]);
const RENDERER_LISTENERS = new Set(["on", "once", "off", "removeListener", "removeAllListeners"]);
const OUTBOUND_NAME = /(?:send|broadcast|emit|post)/i;

/**
 * 根据调用形态判断方向。
 * objectName 是点号左边的标识符；形如 `a.b.f()` 的多级访问取不到，按 undefined 处理。
 * 未知对象上的 `.on(IPC.X)` 视为主进程监听，通道既然是 `IPC.*` 常量，误判几率很小。
 */
function classify(objectName: string | undefined, methodName: string): IpcChannelUseKind | null {
  if (objectName === "ipcRenderer") {
    if (methodName === "invoke") return "invoke";
    if (RENDERER_SENDERS.has(methodName)) return "send";
    return RENDERER_LISTENERS.has(methodName) ? "listen" : null;
  }

  // registerIpc 是插件运行时的入口，最终也会走到 ipcMain.handle
  if (["handle", "handleOnce", "registerIpc"].includes(methodName)) return "handle";

  const outbound = OUTBOUND_NAME.test(methodName);
  if (objectName === undefined) {
    // 孤立函数名只认外发类，例如 sendToPetWindow(IPC.X)
    return outbound ? "outbound" : null;
  }
  if (methodName === "on") return "on";
  return outbound ? "outbound" : null;
}

/** 只接受 `IPC.<KEY>` 形式的属性访问，其余（包括透传的变量）都返回 null。 */
function ipcChannelKey(arg: ts.Expression | undefined): string | null {
  if (!arg || !ts.isPropertyAccessExpression(arg)) return null;
  const owner = arg.expression;
  if (!ts.isIdentifier(owner) || owner.text !== "IPC") return null;
  return arg.name.text;
}

function scriptKindFor(file: string): ts.ScriptKind {
  const kinds: Array<[string, ts.ScriptKind]> = [
    [".tsx", ts.ScriptKind.TSX],
    [".jsx", ts.ScriptKind.JSX],
    [".js", ts.ScriptKind.JS],
  ];
  const hit = kinds.find(([ext]) => file.endsWith(ext));
  return hit ? hit[1] : ts.ScriptKind.TS;
}

function parseSource(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
}

/** 取出调用的 (对象名, 方法名)；不是普通函数调用或成员调用时方法名为 undefined。 */
function describeCallee(callee: ts.LeftHandSideExpression): { objectName?: string; methodName?: string } {
  if (ts.isPropertyAccessExpression(callee)) {
    return {
      objectName: ts.isIdentifier(callee.expression) ? callee.expression.text : undefined,
      methodName: callee.name.text,
    };
  }
  if (ts.isIdentifier(callee)) return { methodName: callee.text };
  return {};
}

export function findIpcChannelUses(file: string, source: string): IpcChannelUse[] {
  const root = parseSource(file, source);
  const found: IpcChannelUse[] = [];

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const { objectName, methodName } = describeCallee(node.expression);
      if (methodName !== undefined) {
        const kind = classify(objectName, methodName);
        const channel = ipcChannelKey(node.arguments[0]);
        if (kind !== null && channel !== null) {
          const { line } = root.getLineAndCharacterOfPosition(node.getStart());
          found.push({ kind, channel, file, line: line + 1 });
        }
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(root);
  return found;
}

const MODULE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", `${path.sep}index.ts`];

/** 把相对路径的模块说明符解析成磁盘文件；外部依赖（非相对）返回 null。 */
function locateRelativeModule(importer: string, specifier: string): string | null {
  if (specifier[0] !== ".") return null;
  const stem = path.resolve(path.dirname(importer), specifier);
  const match = MODULE_SUFFIXES.map((suffix) => stem + suffix).find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  return match ?? null;
}

/** 列出一个文件的静态依赖：import、export-from、import=、require()、动态 import()。 */
function listModuleSpecifiers(file: string, source: string): string[] {
  const root = parseSource(file, source);
  const out: string[] = [];

  const walk = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
        out.push(ref.expression.text);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const viaRequire = ts.isIdentifier(callee) && callee.text === "require";
      const viaImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const firstArg = node.arguments[0];
      if ((viaRequire || viaImport) && firstArg && ts.isStringLiteral(firstArg)) {
        out.push(firstArg.text);
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(root);
  return out;
}

/**
 * 从入口文件出发，沿相对 import 求出可达的文件集合（绝对路径）。
 *
 * 目的是区分“源码里写过注册表达式”和“该文件确实在生产装配路径上”：
 * 只被测试或废弃代码引用的模块不会进入结果。
 *
 * 有意放宽：type-only import 与动态 import 也算可达，宁可少报也不漏判。
 */
export function collectReachableFiles(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [path.resolve(entryFile)];

  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (visited.has(file) || !fs.existsSync(file)) continue;
    visited.add(file);

    const code = fs.readFileSync(file, "utf8");
    for (const spec of listModuleSpecifiers(file, code)) {
      const target = locateRelativeModule(file, spec);
      if (target !== null && !visited.has(target)) stack.push(target);
    }
  }

  return visited;
}
