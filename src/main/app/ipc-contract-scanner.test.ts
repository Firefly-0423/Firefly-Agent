import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectReachableFiles,
  findIpcChannelUses,
  type IpcChannelUse,
} from "./ipc-contract-scanner";

describe("findIpcChannelUses", () => {
  it("classifies renderer, main and outbound call sites", () => {
    const source = [
      "ipcRenderer.invoke(IPC.A);",
      "ipcRenderer.send(IPC.B, 1);",
      "ipcRenderer.sendSync(IPC.C);",
      "ipcRenderer.on(IPC.D, fn);",
      "ipcRenderer.once(IPC.E, fn);",
      "ipcRenderer.off(IPC.F, fn);",
      "ipcRenderer.removeListener(IPC.G, fn);",
      "ipcRenderer.removeAllListeners(IPC.H);",
      "ipcMain.handle(IPC.I, fn);",
      "ipcMain.handleOnce(IPC.J, fn);",
      "runtime.registerIpc(IPC.K, fn);",
      "ipcMain.on(IPC.L, fn);",
      "someEmitter.on(IPC.M, fn);",
      "win.send(IPC.N, payload);",
      "sendToPetWindow(IPC.O);",
      "broadcastToAuxWindows(IPC.P)",
    ].join("\n");

    expect(findIpcChannelUses("src/demo.ts", source)).toEqual([
      { kind: "invoke", channel: "A", file: "src/demo.ts", line: 1 },
      { kind: "send", channel: "B", file: "src/demo.ts", line: 2 },
      { kind: "send", channel: "C", file: "src/demo.ts", line: 3 },
      { kind: "listen", channel: "D", file: "src/demo.ts", line: 4 },
      { kind: "listen", channel: "E", file: "src/demo.ts", line: 5 },
      { kind: "listen", channel: "F", file: "src/demo.ts", line: 6 },
      { kind: "listen", channel: "G", file: "src/demo.ts", line: 7 },
      { kind: "listen", channel: "H", file: "src/demo.ts", line: 8 },
      { kind: "handle", channel: "I", file: "src/demo.ts", line: 9 },
      { kind: "handle", channel: "J", file: "src/demo.ts", line: 10 },
      { kind: "handle", channel: "K", file: "src/demo.ts", line: 11 },
      { kind: "on", channel: "L", file: "src/demo.ts", line: 12 },
      { kind: "on", channel: "M", file: "src/demo.ts", line: 13 },
      { kind: "outbound", channel: "N", file: "src/demo.ts", line: 14 },
      { kind: "outbound", channel: "O", file: "src/demo.ts", line: 15 },
      { kind: "outbound", channel: "P", file: "src/demo.ts", line: 16 },
    ] satisfies IpcChannelUse[]);
  });

  it("ignores unknown methods, non-IPC arguments and non-property IPC access", () => {
    const source = [
      "ipcRenderer.unknown(IPC.A);",
      "ipcRenderer.invoke(channel);",
      'ipcRenderer.invoke("IPC.B");',
      "ipcRenderer.invoke(IPC);",
      'ipcRenderer.invoke(IPC["C"]);',
      "someObject.notify(IPC.D);",
      "plainFunction(IPC.E);",
      "on(IPC.F);",
      "ipcRenderer.invoke(other.IPC.G);",
    ].join("\n");
    expect(findIpcChannelUses("demo.ts", source)).toEqual([]);
  });

  it("treats bare outbound-style and handle-style function names correctly", () => {
    const source = [
      "sendToPetWindow(IPC.A);",
      "emitEvent(IPC.B);",
      "postMessage(IPC.C);",
      "handle(IPC.D, fn);",
      "registerIpc(IPC.E, fn);",
      "someObject.postMessage(IPC.F);",
      "someObject.once(IPC.G);",
    ].join("\n");
    expect(findIpcChannelUses("demo.ts", source).map(({ kind, channel }) => [kind, channel])).toEqual([
      ["outbound", "A"],
      ["outbound", "B"],
      ["outbound", "C"],
      ["handle", "D"],
      ["handle", "E"],
      ["outbound", "F"],
    ]);
  });

  it("only reads the first argument and reports the call's start line", () => {
    const source = [
      "// ipcRenderer.invoke(IPC.COMMENTED);",
      'const text = "ipcRenderer.invoke(IPC.STRING)";',
      "ipcRenderer.invoke(",
      "  IPC.REAL,",
      "  IPC.SECOND,",
      ");",
    ].join("\n");
    expect(findIpcChannelUses("demo.ts", source)).toEqual([
      { kind: "invoke", channel: "REAL", file: "demo.ts", line: 3 },
    ]);
  });

  it("parses TSX and JSX sources without treating JSX as IPC calls", () => {
    const source = "const view = <div data-channel={IPC.NOT_A_CALL} />;\nipcRenderer.invoke(IPC.REAL);";
    expect(findIpcChannelUses("component.tsx", source)).toEqual([
      { kind: "invoke", channel: "REAL", file: "component.tsx", line: 2 },
    ]);
  });
});

describe("collectReachableFiles", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-scanner-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, content: string): string {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return path.resolve(target);
  }

  it("returns an empty set for a missing entry file", () => {
    expect(collectReachableFiles(path.join(root, "missing.ts"))).toEqual(new Set());
  });

  it("walks all supported static dependency forms and resolves suffixes", () => {
    const entry = write(
      "entry.ts",
      [
        'import "./a";',
        'export * from "./b";',
        'const c = require("./c");',
        'const d = import("./dir");',
        'import type { T } from "./types";',
        'import legacy = require("./legacy");',
        'import "./missing";',
        'import "external-package";',
        'import "./prefer";',
      ].join("\n"),
    );
    const a = write("a.ts", 'import "./entry";');
    const b = write("b.ts", "export const b = 1;");
    const c = write("c.js", "module.exports = 1;");
    const dirIndex = write("dir/index.ts", 'import "./sub";');
    const sub = write("dir/sub.tsx", "export const Sub = () => null;");
    const types = write("types.ts", "export type T = string;");
    const legacy = write("legacy.js", "module.exports = 1;");
    const preferTs = write("prefer.ts", "export const preferred = true;");
    write("prefer.js", "module.exports = false;");

    expect(collectReachableFiles(entry)).toEqual(
      new Set([entry, a, b, c, dirIndex, sub, types, legacy, preferTs]),
    );
  });

  it("handles cycles and leaves single files isolated", () => {
    const first = write("first.ts", 'import "./second";');
    const second = write("second.ts", 'import "./first";');
    expect(collectReachableFiles(first)).toEqual(new Set([first, second]));

    const isolated = write("isolated.ts", "export const value = 1;");
    expect(collectReachableFiles(isolated)).toEqual(new Set([isolated]));
  });

  it("ignores dynamic imports whose specifier is not a string literal", () => {
    const entry = write(
      "entry.ts",
      [
        "const name = './later';",
        "const dynamic = import(name);",
        "const required = require(`./later`);",
      ].join("\n"),
    );
    write("later.ts", "export const later = 1;");
    expect(collectReachableFiles(entry)).toEqual(new Set([entry]));
  });
});
