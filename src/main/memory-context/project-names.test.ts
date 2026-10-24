import { describe, expect, it, vi } from "vitest";
import { projectKeyForWorkspaceRoot } from "../memory-policy/project-scope";
import { resolveProjectNames } from "./project-names";

const key = (root: string) => projectKeyForWorkspaceRoot(root);
const session = (root: string, displayName: string) => ({ workspaceBinding: { workspaceRoot: root, displayName } });

describe("resolveProjectNames", () => {
  it("reads nothing when no project key is needed", () => {
    const getSession = vi.fn(), listSessionIds = vi.fn(() => ["a"]), listProjectBindings = vi.fn(() => []);
    expect(resolveProjectNames(new Set(), { getSession, listSessionIds, listProjectBindings }).size).toBe(0);
    expect(getSession).not.toHaveBeenCalled(); expect(listSessionIds).not.toHaveBeenCalled(); expect(listProjectBindings).not.toHaveBeenCalled();
  });

  it("prefers the session index and never loads a session when it is available", () => {
    const getSession = vi.fn();
    const names = resolveProjectNames(new Set([key("C:\work\alpha")]), { getSession, listSessionIds: () => ["a"],
      listProjectBindings: () => [{ workspaceRoot: "C:\work\alpha", displayName: "alpha" }, { workspaceRoot: "C:\work\beta", displayName: "beta" }] });
    expect([...names.values()]).toEqual(["alpha"]); expect(getSession).not.toHaveBeenCalled();
  });

  it("falls back to sessions, stops once every needed key is named, and only names the needed projects", () => {
    const sessions: Record<string, any> = { a: session("C:\work\alpha", "alpha"), b: session("C:\work\beta", "beta"), c: session("C:\work\gamma", "gamma") };
    const getSession = vi.fn((id: string) => sessions[id]);
    const names = resolveProjectNames(new Set([key("C:\work\alpha")]), { getSession, listSessionIds: () => ["a", "b", "c"] });
    expect([...names.values()]).toEqual(["alpha"]); expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("a session that cannot be read, or has an invalid root, only loses its own name", () => {
    const sessions: Record<string, any> = { bad: null, throws: null, empty: session("", "nameless root"), huge: session("x".repeat(5000), "huge"), good: session("C:\work\alpha", "alpha") };
    const getSession = (id: string) => { if (id === "throws") throw new Error("SESSION_READ_FAILED"); return sessions[id]; };
    const names = resolveProjectNames(new Set([key("C:\work\alpha")]), { getSession, listSessionIds: () => ["bad", "throws", "empty", "huge", "good"] });
    expect([...names.values()]).toEqual(["alpha"]);
  });

  it("a failing index or session list yields no names instead of an error", () => {
    const needed = new Set([key("C:\work\alpha")]);
    expect(resolveProjectNames(needed, { getSession: () => null, listSessionIds: () => { throw new Error("INDEX_UNREADABLE"); } }).size).toBe(0);
    expect(resolveProjectNames(needed, { getSession: () => null, listSessionIds: () => [], listProjectBindings: () => { throw new Error("INDEX_UNREADABLE"); } }).size).toBe(0);
  });
});
