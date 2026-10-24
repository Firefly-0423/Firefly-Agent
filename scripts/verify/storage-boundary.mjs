import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const roots = new Set(["appData", "userData", "sessionData", "logs"]);
const bootstrap = new Set(["src/main/app-identity.ts", "src/main/runtime-profile.ts", "src/main/identity-preflight.ts"]);
function typedNonStorageArgument(node, arg) {
  if (!arg || !ts.isIdentifier(arg)) return false;
  for (let owner = node.parent; owner; owner = owner.parent) {
    if (!ts.isFunctionDeclaration(owner) && !ts.isFunctionExpression(owner) && !ts.isArrowFunction(owner) && !ts.isMethodDeclaration(owner)) continue;
    const parameter = owner.parameters.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === arg.text);
    if (!parameter?.type) return false;
    const types = ts.isUnionTypeNode(parameter.type) ? parameter.type.types : [parameter.type];
    return types.every((type) => ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) && !roots.has(type.literal.text));
  }
  return false;
}
export function inventoryDirectAccess(repository) {
  const entries = new Map();
  function inspect(file) {
    const relative = path.relative(repository, file).split(path.sep).join("/");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const method = ts.isPropertyAccessExpression(expression) ? expression.name.text
          : ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text
          : ts.isIdentifier(expression) ? expression.text : undefined;
        if (["getPath", "setPath", "setAppLogsPath"].includes(method)) {
          const arg = node.arguments[0];
          const root = method === "setAppLogsPath" ? "logs" : arg && ts.isStringLiteral(arg) ? arg.text : "DYNAMIC";
          const irrelevant = method === "getPath" && (!arg || typedNonStorageArgument(node, arg));
          if (!irrelevant && (root === "DYNAMIC" || roots.has(root))) {
            const key = `${relative}|${method}|${root}`;
            const entry = entries.get(key) ?? { file: relative, method, root, count: 0, category: bootstrap.has(relative) ? "BOOTSTRAP_ALLOWED" : "MIGRATE_LATER", lines: [] };
            entry.count += 1;
            entry.lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
            entries.set(key, entry);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) inspect(file);
    }
  }
  walk(path.join(repository, "src"));
  return [...entries.values()].sort((a, b) => `${a.file}|${a.method}|${a.root}`.localeCompare(`${b.file}|${b.method}|${b.root}`));
}
export function checkDirectAccess(repository, allowlist) {
  const inventory = inventoryDirectAccess(repository);
  const budgets = new Map(allowlist.map((entry) => [`${entry.file}|${entry.method}|${entry.root}`, entry]));
  for (const entry of inventory) {
    const approved = budgets.get(`${entry.file}|${entry.method}|${entry.root}`);
    if (!approved || entry.count > approved.count) throw new Error(`UNAPPROVED_STORAGE_ACCESS: ${entry.file}:${entry.lines.join(",")} ${entry.method}(${entry.root})`);
    if (entry.root === "DYNAMIC" && approved.category !== "BOOTSTRAP_ALLOWED") throw new Error(`UNAPPROVED_STORAGE_ACCESS: dynamic lookup outside bootstrap ${entry.file}`);
  }
  return { total: inventory.reduce((count, entry) => count + entry.count, 0), files: new Set(inventory.map((entry) => entry.file)).size, inventory };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const inventoryFile = path.join(repository, "scripts/verify/storage-direct-access.json");
  if (process.argv.includes("--write-inventory")) {
    fs.writeFileSync(inventoryFile, `${JSON.stringify(inventoryDirectAccess(repository), null, 2)}\n`);
    console.log(`Inventory written: ${inventoryFile}`);
  } else {
    const allowlist = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
    const result = checkDirectAccess(repository, allowlist);
    console.log(`Storage boundary PASS: ${result.total} allowlisted accesses in ${result.files} files`);
  }
}
