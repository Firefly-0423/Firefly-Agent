import fs from "node:fs";
import path from "node:path";

/**
 * The real npm CLI entry. The SDK is packed and installed with npm on purpose: that is how outside
 * plugin authors consume it, and npm publish (OIDC) is the release path. Under `pnpm run`,
 * npm_execpath points at pnpm, so it is only used when it really is npm.
 */
export function npmCliEntry() {
  const fromRunner = process.env.npm_execpath;
  const candidates = [
    fromRunner && /npm-cli\.[cm]?js$/.test(fromRunner) ? fromRunner : undefined,
    // Windows installer layout: node.exe next to node_modules/npm.
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    // Linux/macOS layout (actions/setup-node, nvm): <prefix>/bin/node and <prefix>/lib/node_modules/npm.
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("Cannot find the npm CLI next to this Node.js; the SDK checks need npm to pack and install the tarball");
  return found;
}
