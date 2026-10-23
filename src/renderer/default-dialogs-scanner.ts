import ts from "typescript";
import path from "node:path";

function scriptKindFor(filename: string): ts.ScriptKind {
  for (const [suffix, kind] of [[".tsx", ts.ScriptKind.TSX], [".jsx", ts.ScriptKind.JSX], [".js", ts.ScriptKind.JS]] as const) {
    if (filename.endsWith(suffix)) return kind;
  }
  return ts.ScriptKind.TS;
}

function isDialogName(name: string): boolean {
  return name === "alert" || name === "confirm";
}

export function findDefaultDialogCalls(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const locations: string[] = [];
  function walk(current: ts.Node): void {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      let matches = false;
      if (ts.isIdentifier(callee)) matches = isDialogName(callee.text);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        matches = callee.expression.text === "window" && isDialogName(callee.name.text);
      }
      if (matches) {
        const position = parsed.getLineAndCharacterOfPosition(current.getStart());
        locations.push(`${path.normalize(file)}:${position.line + 1}`);
      }
    }
    ts.forEachChild(current, walk);
  }
  walk(parsed);
  return locations;
}
