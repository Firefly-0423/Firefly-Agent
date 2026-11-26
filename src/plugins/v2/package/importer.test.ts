import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPluginPackage } from "./importer";
import { packPackage } from "./pack";
import {
  CAN_LINK_DIRECTORY,
  CAN_SYMLINK_FILE,
  createPackage,
  goodManifest,
  linkDirectory,
  linkFile,
} from "./package.test-support";

let root: string;
let pluginsRoot: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ff-v2-importer-"));
  pluginsRoot = path.join(root, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("importPluginPackage", () => {
  it("imports valid local folder, .ffplugin, and .zip into plugins/<id>/<version>/", async () => {
    const srcFolder = createPackage(root, {
      manifest: goodManifest({ id: "dev.firefly.folder", version: "1.0.0" }),
    });
    const folderRes = await importPluginPackage(srcFolder, { pluginsRoot });
    expect(folderRes.ok).toBe(true);
    if (!folderRes.ok) return;
    await folderRes.commit();
    expect(folderRes.installDir).toBe(path.join(pluginsRoot, "dev.firefly.folder", "1.0.0"));
    expect(folderRes.sourceKind).toBe("local-folder");
    expect(existsSync(path.join(folderRes.installDir, "dist", "index.mjs"))).toBe(true);

    // .ffplugin packed by packPackage
    const pkgSrc = createPackage(path.join(root, "src-ff"), {
      manifest: goodManifest({ id: "dev.firefly.packed", version: "2.1.0" }),
    });
    const ffpluginPath = path.join(root, "packed.ffplugin");
    const packed = await packPackage(pkgSrc, ffpluginPath, { hostVersion: "1.2.0" });
    expect(packed.ok).toBe(true);

    const ffRes = await importPluginPackage(ffpluginPath, { pluginsRoot });
    expect(ffRes.ok).toBe(true);
    if (!ffRes.ok) return;
    await ffRes.commit();
    expect(ffRes.installDir).toBe(path.join(pluginsRoot, "dev.firefly.packed", "2.1.0"));
    expect(ffRes.sourceKind).toBe("local-package");
    expect(readFileSync(path.join(ffRes.installDir, "firefly.plugin.json"), "utf8")).toContain("dev.firefly.packed");

    // .zip with single wrapper directory
    const zip = new JSZip();
    zip.file("wrapper/firefly.plugin.json", JSON.stringify(goodManifest({ id: "dev.firefly.zipped", version: "0.3.0" })));
    zip.file("wrapper/dist/index.mjs", "export default { activate() {} };\n");
    zip.file("wrapper/assets/icon.png", Buffer.from([1, 2, 3]));
    zip.file("wrapper/ui/settings.html", "<html></html>");
    const zipPath = path.join(root, "wrapped.zip");
    writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));

    const zipRes = await importPluginPackage(zipPath, { pluginsRoot });
    expect(zipRes.ok).toBe(true);
    if (!zipRes.ok) return;
    await zipRes.commit();
    expect(zipRes.installDir).toBe(path.join(pluginsRoot, "dev.firefly.zipped", "0.3.0"));
    expect(existsSync(path.join(zipRes.installDir, "dist", "index.mjs"))).toBe(true);
  });

  it("rejects traversal, invalid manifests, and 0.x manifests with zero files written", async () => {
    // 1. Manifest path traversal in folder
    const outside = path.join(root, "outside.mjs");
    writeFileSync(outside, "export default {};");
    const traversalDir = createPackage(path.join(root, "bad-traversal"), {
      manifest: goodManifest({ id: "dev.firefly.evil", main: "../outside.mjs" }),
    });
    const traversalRes = await importPluginPackage(traversalDir, { pluginsRoot });
    expect(traversalRes.ok).toBe(false);
    if (!traversalRes.ok) {
      expect(traversalRes.errors.some((e) => e.code === "path_traversal")).toBe(true);
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);

    // 2. ZIP entry traversal (raw ../ member in ZIP headers)
    const badZip = new JSZip();
    badZip.file("firefly.plugin.json", JSON.stringify(goodManifest({ id: "dev.firefly.evilzip" })));
    badZip.file("dist/index.mjs", "export default { activate() {} };\n");
    badZip.file("aa/escaped.txt", "escape", { createFolders: false });
    const badZipPath = path.join(root, "traversal.zip");
    const badBuf = await badZip.generateAsync({ type: "nodebuffer" });
    let offset = badBuf.indexOf("aa/escaped.txt");
    while (offset !== -1) {
      badBuf.write("../escaped.txt", offset);
      offset = badBuf.indexOf("aa/escaped.txt", offset + 14);
    }
    writeFileSync(badZipPath, badBuf);
    const badZipRes = await importPluginPackage(badZipPath, { pluginsRoot });
    expect(badZipRes.ok).toBe(false);
    if (!badZipRes.ok) {
      expect(badZipRes.errors.some((e) => e.code === "path_traversal")).toBe(true);
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);

    // 3. Invalid manifest (risk: ["safe"])
    const invalidDir = createPackage(path.join(root, "bad-safe"), {
      manifest: goodManifest({
        id: "dev.firefly.unsafe",
        tools: [{ name: "ping", title: "Ping", risk: ["safe"] as never, modes: ["work"] }],
      }),
    });
    const invalidRes = await importPluginPackage(invalidDir, { pluginsRoot });
    expect(invalidRes.ok).toBe(false);
    if (!invalidRes.ok) {
      expect(invalidRes.errors.some((e) => e.code === "risk_safe_forbidden")).toBe(true);
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);

    // 4. 0.x manifest.json in folder & archive
    const legacyDir = path.join(root, "legacy-folder");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "manifest.json"), JSON.stringify({
      apiVersion: 1,
      id: "legacy-plugin",
      name: "Legacy",
      version: "1.0.0",
      description: "Old",
      author: "test",
      entry: "index.cjs",
    }));
    writeFileSync(path.join(legacyDir, "index.cjs"), "module.exports={};");
    const legacyRes = await importPluginPackage(legacyDir, { pluginsRoot });
    expect(legacyRes.ok).toBe(false);
    if (!legacyRes.ok) {
      expect(legacyRes.errors[0].code).toBe("legacy_manifest");
      expect(legacyRes.errors[0].message).toContain("0.x");
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);

    const legacyZip = new JSZip();
    legacyZip.file("manifest.json", JSON.stringify({ apiVersion: 1, id: "legacy-zip", name: "Old", version: "1.0.0", entry: "index.cjs" }));
    legacyZip.file("index.cjs", "module.exports={};");
    const legacyZipPath = path.join(root, "legacy.zip");
    writeFileSync(legacyZipPath, await legacyZip.generateAsync({ type: "nodebuffer" }));
    const legacyZipRes = await importPluginPackage(legacyZipPath, { pluginsRoot });
    expect(legacyZipRes.ok).toBe(false);
    if (!legacyZipRes.ok) {
      expect(legacyZipRes.errors[0].code).toBe("legacy_manifest");
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);
  });

  it("rejects symlink entries inside zip archives with zero files written", async () => {
    const zip = new JSZip();
    zip.file("firefly.plugin.json", JSON.stringify(goodManifest({ id: "dev.firefly.symlinkzip" })));
    zip.file("dist/index.mjs", "../outside.mjs", { unixPermissions: 0o120777 });
    const zipPath = path.join(root, "symlink.ffplugin");
    writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));

    const res = await importPluginPackage(zipPath, { pluginsRoot });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].code).toBe("symlink_not_allowed");
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);
  });

  it.skipIf(!CAN_SYMLINK_FILE && !CAN_LINK_DIRECTORY)("rejects escaping symlinks in local folders with zero files written", async () => {
    const outside = path.join(root, "outside-secret.mjs");
    writeFileSync(outside, "export default {};");
    const folder = createPackage(path.join(root, "symlink-folder"), {
      manifest: goodManifest({ id: "dev.firefly.symlinkdir" }),
    });
    if (CAN_SYMLINK_FILE) {
      rmSync(path.join(folder, "dist", "index.mjs"));
      linkFile(outside, path.join(folder, "dist", "index.mjs"));
    } else {
      const outsideDir = path.join(root, "outside-dir");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(path.join(outsideDir, "index.mjs"), "export default {};");
      rmSync(path.join(folder, "dist"), { recursive: true, force: true });
      linkDirectory(outsideDir, path.join(folder, "dist"));
    }

    const res = await importPluginPackage(folder, { pluginsRoot });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(["path_symlink_escape", "symlink_not_allowed"]).toContain(res.errors[0].code);
    }
    expect(readdirSync(pluginsRoot)).toEqual([]);
  });

  describe("deferSwap", () => {
    const pluginId = "dev.firefly.deferred";
    const entry = (installDir: string) => path.join(installDir, "dist", "index.mjs");

    async function installV1(): Promise<string> {
      const v1 = createPackage(path.join(root, "src-v1"), {
        manifest: goodManifest({ id: pluginId, version: "1.0.0" }),
        files: { "dist/index.mjs": "export default { build: 'old' };\n", "assets/icon.png": "png", "ui/settings.html": "<!doctype html>" },
      });
      const first = await importPluginPackage(v1, { pluginsRoot });
      if (!first.ok) throw new Error("fixture import failed");
      await first.commit();
      return first.installDir;
    }

    function overwritePackage() {
      return createPackage(path.join(root, "src-v1-new"), {
        manifest: goodManifest({ id: pluginId, version: "1.0.0" }),
        files: { "dist/index.mjs": "export default { build: 'new' };\n", "assets/icon.png": "png", "ui/settings.html": "<!doctype html>" },
      });
    }

    it("stages without touching the installed directory until swap(), then commit removes the backup", async () => {
      const installDir = await installV1();
      const res = await importPluginPackage(overwritePackage(), { pluginsRoot, allowOverwrite: true, deferSwap: true });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.installDir).toBe(installDir);
      expect(readFileSync(entry(installDir), "utf8")).toContain("'old'");
      expect(readdirSync(path.join(pluginsRoot, pluginId)).some((name) => name.startsWith(".staging-"))).toBe(true);

      await res.swap!();
      expect(readFileSync(entry(installDir), "utf8")).toContain("'new'");
      await res.commit();
      expect(readdirSync(path.join(pluginsRoot, pluginId))).toEqual(["1.0.0"]);
    });

    it("rollback before swap() removes staging and leaves the installed files untouched", async () => {
      const installDir = await installV1();
      const res = await importPluginPackage(overwritePackage(), { pluginsRoot, allowOverwrite: true, deferSwap: true });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await res.rollback();

      expect(readFileSync(entry(installDir), "utf8")).toContain("'old'");
      expect(readdirSync(path.join(pluginsRoot, pluginId))).toEqual(["1.0.0"]);
    });

    it("restores the old directory and clears staging when swap() fails while moving staging into place", async () => {
      const installDir = await installV1();
      const res = await importPluginPackage(overwritePackage(), {
        pluginsRoot,
        allowOverwrite: true,
        deferSwap: true,
        fs: {
          async rename(from, to) {
            if (path.basename(String(from)).startsWith(".staging-")) throw new Error("EPERM staging rename");
            return fsPromises.rename(from, to);
          },
        },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await expect(res.swap!()).rejects.toThrow("EPERM staging rename");

      expect(readFileSync(entry(installDir), "utf8")).toContain("'old'");
      expect(readdirSync(path.join(pluginsRoot, pluginId))).toEqual(["1.0.0"]);
      await res.rollback();
      expect(readFileSync(entry(installDir), "utf8")).toContain("'old'");
    });

    it("rollback after swap() restores the previous files", async () => {
      const installDir = await installV1();
      const res = await importPluginPackage(overwritePackage(), { pluginsRoot, allowOverwrite: true, deferSwap: true });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await res.swap!();
      await res.rollback();

      expect(readFileSync(entry(installDir), "utf8")).toContain("'old'");
      expect(readdirSync(path.join(pluginsRoot, pluginId))).toEqual(["1.0.0"]);
    });
  });

  it("refuses allowOverwrite=false without creating staging or touching existing version (D7)", async () => {
    const pluginId = "dev.firefly.nooverwrite";
    const v1Folder = createPackage(path.join(root, "src-v1"), {
      manifest: goodManifest({ id: pluginId, version: "1.0.0" }),
      files: {
        "dist/index.mjs": "export default { version: 'v1-original' };\n",
        "assets/icon.png": "png",
        "ui/settings.html": "<!doctype html>v1",
      },
    });
    const first = await importPluginPackage(v1Folder, { pluginsRoot });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.commit();

    const v1Duplicate = createPackage(path.join(root, "src-v1-dup"), {
      manifest: goodManifest({ id: pluginId, version: "1.0.0" }),
      files: {
        "dist/index.mjs": "export default { version: 'v1-overwrite-attempt' };\n",
        "assets/icon.png": "png",
        "ui/settings.html": "<!doctype html>v1-new",
      },
    });

    const mkdirSpy = vi.fn(fsPromises.mkdir);
    const rejected = await importPluginPackage(v1Duplicate, {
      pluginsRoot,
      allowOverwrite: false,
      fs: { mkdir: mkdirSpy },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors[0].code).toBe("invalid_value");
    }
    expect(mkdirSpy).not.toHaveBeenCalled();

    const pluginIdDir = path.join(pluginsRoot, pluginId);
    expect(readdirSync(pluginIdDir)).toEqual(["1.0.0"]);
    expect(readFileSync(path.join(pluginIdDir, "1.0.0", "dist", "index.mjs"), "utf8")).toContain("v1-original");
  });

  it("cleans staging in finally if target appears mid-import with allowOverwrite=false (D7)", async () => {
    const pluginId = "dev.firefly.raceoverwrite";
    const pkgFolder = createPackage(path.join(root, "src-race"), {
      manifest: goodManifest({ id: pluginId, version: "1.0.0" }),
      files: {
        "dist/index.mjs": "export default { version: 'new' };\n",
        "assets/icon.png": "png",
        "ui/settings.html": "<!doctype html>",
      },
    });

    const targetDir = path.join(pluginsRoot, pluginId, "1.0.0");
    let lstatCount = 0;
    const rejected = await importPluginPackage(pkgFolder, {
      pluginsRoot,
      allowOverwrite: false,
      fs: {
        async lstat(target, ...rest) {
          if (path.resolve(String(target)) === path.resolve(targetDir)) {
            lstatCount += 1;
            // First two checks (pre-check & after mkdir pluginIdDir): missing.
            // After staging copy completes: simulate concurrent creation of targetDir.
            if (lstatCount >= 5) {
              mkdirSync(targetDir, { recursive: true });
              writeFileSync(path.join(targetDir, "marker.txt"), "concurrent-original", "utf8");
            }
          }
          return await fsPromises.lstat(target, ...rest);
        },
      },
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors[0].code).toBe("invalid_value");
    }
    const pluginIdDir = path.join(pluginsRoot, pluginId);
    expect(readdirSync(pluginIdDir)).toEqual(["1.0.0"]);
    expect(readFileSync(path.join(targetDir, "marker.txt"), "utf8")).toBe("concurrent-original");
  });

  // Skip cleanly on environments that disallow directory junctions/symlinks.
  it.skipIf(!CAN_LINK_DIRECTORY)(
    "rejects symlinked/junctioned pluginsRoot, parent, pluginIdDir, and targetDir without touching out-of-bounds targets (D1)",
    async () => {
      const outside = path.join(root, "outside-target");
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, "untouched.txt"), "keep-me", "utf8");

      const pkg = createPackage(path.join(root, "src-valid"), {
        manifest: goodManifest({ id: "dev.firefly.junc", version: "1.0.0" }),
      });

      // 1. pluginsRoot itself is a junction
      const linkedPluginsRoot = path.join(root, "linked-plugins-root");
      linkDirectory(outside, linkedPluginsRoot);
      const resRoot = await importPluginPackage(pkg, { pluginsRoot: linkedPluginsRoot });
      expect(resRoot.ok).toBe(false);
      if (!resRoot.ok) expect(resRoot.errors[0].code).toBe("symlink_not_allowed");
      expect(readdirSync(outside)).toEqual(["untouched.txt"]);

      // 2. Parent of non-existent pluginsRoot is a junction
      const linkedParent = path.join(root, "linked-parent");
      linkDirectory(outside, linkedParent);
      const nestedPluginsRoot = path.join(linkedParent, "nested-plugins");
      const resParent = await importPluginPackage(pkg, { pluginsRoot: nestedPluginsRoot });
      expect(resParent.ok).toBe(false);
      if (!resParent.ok) expect(resParent.errors[0].code).toBe("symlink_not_allowed");
      expect(existsSync(path.join(outside, "nested-plugins"))).toBe(false);
      expect(readdirSync(outside)).toEqual(["untouched.txt"]);

      // 3. pluginIdDir (<pluginsRoot>/<id>) is a junction
      const rootWithPluginLink = path.join(root, "plugins-with-id-link");
      mkdirSync(rootWithPluginLink, { recursive: true });
      linkDirectory(outside, path.join(rootWithPluginLink, "dev.firefly.junc"));
      const resPluginDir = await importPluginPackage(pkg, { pluginsRoot: rootWithPluginLink });
      expect(resPluginDir.ok).toBe(false);
      if (!resPluginDir.ok) expect(resPluginDir.errors[0].code).toBe("symlink_not_allowed");
      expect(readdirSync(outside)).toEqual(["untouched.txt"]);

      // 4. targetDir (<pluginsRoot>/<id>/<version>) is a junction (both allowOverwrite true and false)
      const rootWithTargetLink = path.join(root, "plugins-with-version-link");
      mkdirSync(path.join(rootWithTargetLink, "dev.firefly.junc"), { recursive: true });
      linkDirectory(outside, path.join(rootWithTargetLink, "dev.firefly.junc", "1.0.0"));
      for (const allowOverwrite of [true, false]) {
        const resTarget = await importPluginPackage(pkg, { pluginsRoot: rootWithTargetLink, allowOverwrite });
        expect(resTarget.ok).toBe(false);
        if (!resTarget.ok) expect(resTarget.errors[0].code).toBe("symlink_not_allowed");
        expect(readFileSync(path.join(outside, "untouched.txt"), "utf8")).toBe("keep-me");
        expect(readdirSync(outside)).toEqual(["untouched.txt"]);
        expect(readdirSync(path.join(rootWithTargetLink, "dev.firefly.junc"))).toEqual(["1.0.0"]);
      }
    },
  );

  it("blocks TOCTOU symlink swaps during publish, commit, and rollback via I/O seam (D1)", async () => {
    const pkg = createPackage(path.join(root, "src-toctou"), {
      manifest: goodManifest({ id: "dev.firefly.toctou", version: "1.0.0" }),
    });
    const targetDir = path.join(pluginsRoot, "dev.firefly.toctou", "1.0.0");

    // 1. Target becomes symlink right before publish rename
    let renameCalled = false;
    let cpDone = false;
    const publishRejected = await importPluginPackage(pkg, {
      pluginsRoot,
      fs: {
        async cp(src, dst, opts) {
          cpDone = true;
          return fsPromises.cp(src, dst, opts);
        },
        async lstat(target, ...rest) {
          const info = await fsPromises.lstat(target, ...rest);
          return info;
        },
        async rename(oldPath, newPath) {
          renameCalled = true;
          return fsPromises.rename(oldPath, newPath);
        },
      },
    });
    // Baseline succeeds when no swap occurs
    expect(cpDone).toBe(true);
    expect(renameCalled).toBe(true);
    expect(publishRejected.ok).toBe(true);
    if (publishRejected.ok) await publishRejected.commit();

    // Now inject symlink report on targetDir after copy completes (before backup/publish)
    let targetIsSwapped = false;
    const rmSpy = vi.fn(fsPromises.rm);
    const renameSpy = vi.fn(fsPromises.rename);
    const swappedRes = await importPluginPackage(pkg, {
      pluginsRoot,
      fs: {
        async cp(src, dst, opts) {
          const out = await fsPromises.cp(src, dst, opts);
          targetIsSwapped = true;
          return out;
        },
        async lstat(target, ...rest) {
          const info = await fsPromises.lstat(target, ...rest);
          if (targetIsSwapped && path.resolve(String(target)) === path.resolve(targetDir)) {
            return {
              ...info,
              isSymbolicLink: () => true,
              isDirectory: () => false,
            } as unknown as Awaited<ReturnType<typeof fsPromises.lstat>>;
          }
          return info;
        },
        rm: rmSpy,
        rename: renameSpy,
      },
    });
    expect(swappedRes.ok).toBe(false);
    if (!swappedRes.ok) {
      expect(swappedRes.errors[0].code).toBe("symlink_not_allowed");
    }
    expect(renameSpy).not.toHaveBeenCalled();
    expect(readdirSync(path.join(pluginsRoot, "dev.firefly.toctou"))).toEqual(["1.0.0"]);

    // 2. Target becomes symlink before rollback() -> rollback rejects without calling rm/rename on symlink
    let hijackRollback = false;
    const rollbackRmSpy = vi.fn(fsPromises.rm);
    const rollbackRenameSpy = vi.fn(fsPromises.rename);
    const handle = await importPluginPackage(pkg, {
      pluginsRoot,
      fs: {
        async lstat(target, ...rest) {
          const info = await fsPromises.lstat(target, ...rest);
          if (hijackRollback && path.resolve(String(target)) === path.resolve(targetDir)) {
            return {
              ...info,
              isSymbolicLink: () => true,
              isDirectory: () => false,
            } as unknown as Awaited<ReturnType<typeof fsPromises.lstat>>;
          }
          return info;
        },
        rm: rollbackRmSpy,
        rename: rollbackRenameSpy,
      },
    });
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;
    rollbackRmSpy.mockClear();
    rollbackRenameSpy.mockClear();
    hijackRollback = true;
    await expect(handle.rollback()).rejects.toThrow(/符号链接|junction/);
    expect(rollbackRmSpy).not.toHaveBeenCalled();
    expect(rollbackRenameSpy).not.toHaveBeenCalled();
  });
});
