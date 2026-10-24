import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("production logger CommonJS initialization", () => {
  it.each(["src/shared/logger.ts", "src/main/logger.ts"])("loads %s with the production module ordering", (file) => {
    const modules = new Map<string, Record<string, unknown>>();
    const nativeRequire = createRequire(path.resolve(file));
    function load(filename: string): Record<string, unknown> {
      const absolute = path.resolve(filename);
      if (modules.has(absolute)) return modules.get(absolute)!;
      const exports: Record<string, unknown> = {};
      modules.set(absolute, exports);
      const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText;
      vm.runInNewContext(compiled, {
        exports,
        process: { env: { FIREFLY_LOG_LEVEL: "error" } },
        require(specifier: string) {
          if (specifier === "node:process") return { env: { FIREFLY_LOG_LEVEL: "error" } };
          if (isBuiltin(specifier)) return nativeRequire(specifier);
          return load(path.resolve(path.dirname(absolute), `${specifier}.ts`));
        },
      }, { filename: absolute });
      return exports;
    }
    expect(() => load(file)).not.toThrow();
    const shared = load("src/shared/logger.ts");
    expect((shared.getLogLevel as () => string)()).toBe("error");
  });
});
