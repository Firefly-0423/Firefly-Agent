import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLspServer } from "./server-discovery";
import type { LspServerDefinition } from "./types";

let sandbox: string;
let workspace: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ff-lsp-find-"));
  workspace = path.join(sandbox, "proj");
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function touch(...segments: string[]): string {
  const target = path.join(sandbox, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");
  return target;
}

function defOf(...commands: Array<[string, string[]?]>): LspServerDefinition {
  return {
    id: "demo",
    extensions: [".demo"],
    commands: commands.map(([command, args]) => ({ command, args: args ?? [] })),
    rootMarkers: [],
    installHint: "demo",
  };
}

const pathOf = (...dirs: string[]) => dirs.map((d) => path.join(sandbox, d)).join(path.delimiter);

describe("resolveLspServer：查找顺序", () => {
  it("绝对路径命令优先于工作区与 PATH 中的同名程序", () => {
    const absolute = touch("abs", "srv");
    touch("proj", "node_modules", ".bin", "srv");
    touch("sysbin", "srv");
    const res = resolveLspServer(defOf([absolute]), workspace, { PATH: pathOf("sysbin"), platform: "linux" });
    expect(res?.executablePath).toBe(absolute);
  });

  it("绝对路径不存在时不回退到其他位置", () => {
    touch("sysbin", "srv");
    const ghost = path.join(sandbox, "ghost", "srv");
    expect(resolveLspServer(defOf([ghost]), workspace, { PATH: pathOf("sysbin"), platform: "linux" })).toBeNull();
  });

  it("绝对路径指向目录时视为不存在", () => {
    const dir = path.join(sandbox, "adir");
    fs.mkdirSync(dir);
    expect(resolveLspServer(defOf([dir]), workspace, { PATH: "", platform: "linux" })).toBeNull();
  });

  it("工作区 node_modules/.bin 优先于 PATH", () => {
    const local = touch("proj", "node_modules", ".bin", "srv");
    touch("sysbin", "srv");
    const res = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("sysbin"), platform: "linux" });
    expect(res?.executablePath).toBe(local);
  });

  it("PATH 中按目录顺序取第一个命中", () => {
    const first = touch("a", "srv");
    touch("b", "srv");
    const res = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("a", "b"), platform: "linux" });
    expect(res?.executablePath).toBe(first);
  });

  it("PATH 中的目录同名条目不算命中，会继续往后找", () => {
    fs.mkdirSync(path.join(sandbox, "a", "srv"), { recursive: true });
    const real = touch("b", "srv");
    const res = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("a", "b"), platform: "linux" });
    expect(res?.executablePath).toBe(real);
  });

  it("PATH 为空或全是空段时找不到", () => {
    expect(resolveLspServer(defOf(["srv"]), workspace, { PATH: "", platform: "linux" })).toBeNull();
    expect(resolveLspServer(defOf(["srv"]), workspace, { PATH: path.delimiter + path.delimiter, platform: "linux" })).toBeNull();
  });
});

describe("resolveLspServer：多条候选命令与返回值", () => {
  it("按声明顺序尝试命令，返回第一条可用的及其参数", () => {
    touch("bin", "second");
    const res = resolveLspServer(
      defOf(["first", ["--a"]], ["second", ["--b", "--c"]]),
      workspace,
      { PATH: pathOf("bin"), platform: "linux" },
    );
    expect(res?.executablePath).toBe(path.join(sandbox, "bin", "second"));
    expect(res?.args).toEqual(["--b", "--c"]);
  });

  it("前面的命令可用时不再看后面的", () => {
    touch("bin", "first");
    touch("bin", "second");
    const res = resolveLspServer(defOf(["first"], ["second"]), workspace, { PATH: pathOf("bin"), platform: "linux" });
    expect(res?.executablePath).toBe(path.join(sandbox, "bin", "first"));
  });

  it("返回的 definition 是传入对象，args 是拷贝", () => {
    touch("bin", "srv");
    const def = defOf(["srv", ["-x"]]);
    const res = resolveLspServer(def, workspace, { PATH: pathOf("bin"), platform: "linux" })!;
    expect(res.definition).toBe(def);
    res.args.push("-y");
    expect(def.commands[0].args).toEqual(["-x"]);
  });

  it("命令列表为空时返回 null", () => {
    expect(resolveLspServer(defOf(), workspace, { PATH: pathOf("bin"), platform: "linux" })).toBeNull();
  });
});

describe("resolveLspServer：Windows 扩展名", () => {
  it("无扩展名的命令按 PATHEXT 依次补全", () => {
    const hit = touch("bin", "srv.cmd");
    const res = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("bin"), PATHEXT: ".EXE;.CMD", platform: "win32" });
    expect(res?.executablePath).toBe(hit);
  });

  it("工作区 .bin 下的 .cmd 优先于 PATH 中的 .exe", () => {
    const local = touch("proj", "node_modules", ".bin", "srv.cmd");
    touch("bin", "srv.exe");
    const res = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("bin"), PATHEXT: ".EXE;.CMD", platform: "win32" });
    expect(res?.executablePath).toBe(local);
  });

  it("PATHEXT 顺序决定同目录内谁先命中", () => {
    touch("bin", "srv.exe");
    touch("bin", "srv.cmd");
    const cmdFirst = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("bin"), PATHEXT: ".CMD;.EXE", platform: "win32" });
    expect(path.basename(cmdFirst!.executablePath)).toBe("srv.cmd");
  });

  it("未提供 PATHEXT 时使用内置后缀（含 .exe）", () => {
    const hit = touch("bin", "srv.exe");
    const original = process.env.PATHEXT;
    delete process.env.PATHEXT;
    try {
      const res = resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("bin"), platform: "win32" });
      expect(res?.executablePath).toBe(hit);
    } finally {
      if (original !== undefined) process.env.PATHEXT = original;
    }
  });

  it("命令已带扩展名时不再补全", () => {
    touch("bin", "srv.exe.cmd");
    expect(resolveLspServer(defOf(["srv.exe"]), workspace, { PATH: pathOf("bin"), PATHEXT: ".CMD", platform: "win32" })).toBeNull();
  });

  it("非 Windows 平台不会按 PATHEXT 补全", () => {
    touch("bin", "srv.exe");
    expect(resolveLspServer(defOf(["srv"]), workspace, { PATH: pathOf("bin"), PATHEXT: ".EXE", platform: "linux" })).toBeNull();
  });
});
