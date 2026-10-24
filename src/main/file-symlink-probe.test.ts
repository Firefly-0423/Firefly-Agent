import { expect, it, vi } from "vitest";
import { probeFileSymlink, Win32SymlinkError } from "../../scripts/verify/file-symlink-probe";

it("confirms success only after creating and removing a real probe", () => {
  const create = vi.fn(), remove = vi.fn();
  expect(probeFileSymlink("target", "link", { create, remove })).toEqual({ supported: true });
  expect(create).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
});

it("only confirmed native creation error 1314 can skip, with an explicit reason", () => {
  const remove = vi.fn();
  expect(probeFileSymlink("target", "link", {
    create: () => { throw new Win32SymlinkError(1314); }, remove,
  })).toEqual({ supported: false, reason: "Windows file symlink unavailable: ERROR_PRIVILEGE_NOT_HELD (1314)" });
  expect(remove).not.toHaveBeenCalled();
});

it.each([5, 87, 183, 3, 112])("native creation error %s must fail rather than silently skip", code => {
  const error = new Win32SymlinkError(code), remove = vi.fn();
  expect(() => probeFileSymlink("target", "link", {
    create: () => { throw error; }, remove,
  })).toThrow(error);
  expect(remove).not.toHaveBeenCalled();
});

it.each(["EPERM", "EACCES", "EEXIST", "ENOENT", "ENOSPC"])("ambiguous Node %s cannot establish native 1314", code => {
  const error = Object.assign(new Error("unconfirmed Node error"), { code, errno: -4048 });
  expect(() => probeFileSymlink("target", "link", {
    create: () => { throw error; }, remove: vi.fn(),
  })).toThrow(error);
});

it("unexpected native-helper or JSON failures propagate", () => {
  const error = new SyntaxError("invalid native diagnostic response");
  expect(() => probeFileSymlink("target", "link", {
    create: () => { throw error; }, remove: vi.fn(),
  })).toThrow(error);
});

it.each([new Win32SymlinkError(1314), Object.assign(new Error("delete denied"), { code: "EPERM" })])(
  "cleanup failure cannot turn a successful creation into a skip", error => {
    expect(() => probeFileSymlink("target", "link", {
      create: vi.fn(), remove: () => { throw error; },
    })).toThrow(error);
  },
);
