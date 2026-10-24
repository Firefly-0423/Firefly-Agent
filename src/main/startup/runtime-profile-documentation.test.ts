import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { resolveRuntimeProfile } from "./runtime-profile";

describe("runtime profile startup documentation", () => {
  it.each(["README.md", "README.en.md"])("%s supplies isolation before either unpackaged launch", (file) => {
    const source = fs.readFileSync(path.resolve(file), "utf8");
    expect(source).toContain('$env:FIREFLY_ISOLATION_ROOT');
    expect(source).toContain('Join-Path (Get-Location).Path "output\\development-profile"');
    const isolation = source.indexOf('$env:FIREFLY_ISOLATION_ROOT');
    expect(isolation).toBeLessThan(source.indexOf('npm run dev'));
    expect(isolation).toBeLessThan(source.indexOf('npm start'));
    expect(source).not.toMatch(/开发与构建实例使用同一正式数据身份|Development and built instances share the production data identity/);
  });
  it.each(["README.md", "README.en.md"])("%s environment also resolves plain npm start", (file) => {
    const source = fs.readFileSync(path.resolve(file), "utf8");
    const profile = /\$env:FIREFLY_RUNTIME_PROFILE\s*=\s*"([^"]+)"/.exec(source)?.[1];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-start-docs-"));
    const isolationRoot = path.join(root, "workspace");
    fs.mkdirSync(isolationRoot);
    try {
      const resolved = resolveRuntimeProfile({
        argv: [], isPackaged: false, productionAppData: path.join(root, "production"),
        env: { FIREFLY_RUNTIME_PROFILE: profile, FIREFLY_ISOLATION_ROOT: isolationRoot },
      });
      expect(resolved.kind).toBe("development");
      // Windows temporary directories can use an 8.3 alias; the resolver owns canonical roots.
      expect(resolved.userData).toBe(path.join(fs.realpathSync.native(isolationRoot), "Firefly-development"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
