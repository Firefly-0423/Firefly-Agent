// Vite plugin for the promo site: lists every npm package the bundle actually contains, with its license text,
// and copies the project's own notices, so the published site carries the licenses of what it redistributes.
// The installer gets the same files through electron-builder.yml; the site build does not run electron-builder.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const NODE_MODULES = "/node_modules/";

/** The package root (…/node_modules/name or …/node_modules/@scope/name) that a module id belongs to, or null. */
export function packageRootOf(id) {
  const path = id.split("?")[0].replace(/\\/g, "/").replace(/^\0/, "");
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const parts = path.slice(at + NODE_MODULES.length).split("/");
  const depth = parts[0]?.startsWith("@") ? 2 : 1;
  if (parts.length <= depth) return null;
  return path.slice(0, at + NODE_MODULES.length) + parts.slice(0, depth).join("/");
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map(entry => entry.type ?? entry).join(" OR ");
  return "UNKNOWN";
}

/** One text file: each bundled package's name, version, declared license and the license files it ships. */
export function thirdPartyNotice(moduleIds, title) {
  const roots = [...new Set(moduleIds.map(packageRootOf).filter(Boolean))];
  const entries = roots.flatMap((root) => {
    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const files = readdirSync(root).filter(name => LICENSE_FILE.test(name)).sort();
    return [{ name: manifest.name ?? root, version: manifest.version ?? "", license: declaredLicense(manifest),
      texts: files.map(name => ({ name, text: readFileSync(join(root, name), "utf8").trim() })) }];
  });
  const unique = [...new Map(entries.map(entry => [`${entry.name}@${entry.version}`, entry])).values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks = unique.map(entry => [
    `${"=".repeat(72)}\n${entry.name}@${entry.version} (${entry.license})\n${"=".repeat(72)}`,
    ...(entry.texts.length ? entry.texts.map(file => `--- ${file.name} ---\n${file.text}`)
      : [`The package ships no license file; its package.json declares: ${entry.license}.`]),
  ].join("\n\n"));
  return `${title}\n\nThird-party packages bundled into this part of the site, with their license texts (${unique.length} ${unique.length === 1 ? "package" : "packages"}).\n\n${blocks.join("\n\n\n")}\n`;
}

/**
 * @param {{ outDir: string; title: string; copy?: Array<[from: string, to: string]> }} options
 * Writes licenses/third-party.txt into outDir after the build, and copies each `from` file to outDir/`to`.
 */
export function siteLicenses({ outDir, title, copy = [] }) {
  let moduleIds = [];
  let root = process.cwd();
  return {
    name: "firefly-site-licenses",
    apply: "build",
    configResolved(config) { root = config.root; },
    // Modules cover what JavaScript imports; fonts pulled in by a CSS @import only show up as emitted assets.
    generateBundle(_options, bundle) {
      // Asset source names are relative to the Vite root.
      const assets = Object.values(bundle).flatMap(output => output.type === "asset" ? output.originalFileNames ?? [] : [])
        .map(name => resolve(root, name));
      moduleIds = [...this.getModuleIds(), ...assets];
    },
    closeBundle() {
      mkdirSync(join(outDir, "licenses"), { recursive: true });
      writeFileSync(join(outDir, "licenses", "third-party.txt"), thirdPartyNotice(moduleIds, title));
      for (const [from, to] of copy) {
        mkdirSync(dirname(join(outDir, to)), { recursive: true });
        cpSync(from, join(outDir, to));
      }
    },
  };
}
