import { resolve } from "node:path";
import { expect, it } from "vitest";
import { packageRootOf, thirdPartyNotice } from "../../scripts/build/site-licenses.mjs";

it("maps module ids, including scoped and nested packages, to their package root", () => {
  expect(packageRootOf("E:\\repo\\node_modules\\react\\index.js")).toBe("E:/repo/node_modules/react");
  expect(packageRootOf("/repo/node_modules/@fontsource-variable/noto-sans-sc/files/a.woff2?url")).toBe("/repo/node_modules/@fontsource-variable/noto-sans-sc");
  expect(packageRootOf("/repo/node_modules/a/node_modules/b/lib/x.js")).toBe("/repo/node_modules/a/node_modules/b");
  expect(packageRootOf("/repo/src/renderer/web-demo/main.tsx")).toBeNull();
  expect(packageRootOf("\0vite/preload-helper.js")).toBeNull();
});

it("lists each bundled package once with its declared license and the license text it ships", () => {
  const modules = resolve("node_modules");
  const notice = thirdPartyNotice([
    `${modules}/react/index.js`, `${modules}/react/cjs/react.production.js`,
    `${modules}/@fontsource-variable/jetbrains-mono/index.css`,
    resolve("src/renderer/web-demo/main.tsx"),
  ], "Test bundle");
  expect(notice).toMatch(/^Test bundle\n/);
  expect(notice).toContain("(2 packages)");
  expect(notice.match(/^react@\S+ \(MIT\)$/m)).not.toBeNull();
  expect(notice).toMatch(/^@fontsource-variable\/jetbrains-mono@\S+ \(OFL-1\.1\)$/m);
  expect(notice).toContain("SIL OPEN FONT LICENSE");
  expect(notice).toContain("Permission is hereby granted, free of charge");
});
