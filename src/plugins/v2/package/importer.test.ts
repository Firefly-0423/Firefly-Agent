import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
