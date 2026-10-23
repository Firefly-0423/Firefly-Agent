import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import { createGitService } from "./git-service";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-runtime-")));
  roots.push(root);
  const templates = path.join(root, "empty-templates");
  fs.mkdirSync(templates);
  execFileSync("git", ["init", "--initial-branch=main", `--template=${templates}`], { cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  const session: ChatSession = { id: "public-git-fixture", title: "public Git fixture", identityId: null, messages: [], createdAt: 1, updatedAt: 1, schemaVersion: 1, mode: "code", workspaceBinding: { workspaceRoot: root, displayName: "public fixture", boundAt: 1 } };
  return { root, session };
}

describe("actual simple-git runtime compatibility", () => {
  it("does not inherit trace destinations or injected Git configuration from the host", () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-host-env-")));
    roots.push(root);
    const trace = path.join(root, "must-not-write-trace.json");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", path.join(root, "must-not-load-hooks"));
    fixture();
    expect(fs.existsSync(trace)).toBe(false);
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("keeps the normal system Git path working without granting inherited pager execution", async () => {
    const context = fixture();
    vi.stubEnv("GIT_PAGER", "firefly-public-never-execute");
    vi.stubEnv("PAGER", "firefly-public-never-execute");
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "system", version: "public-fixture" }) });
    try {
      expect((await service.getStatusForSession(context.session.id)).state).toBe("ready");
    } finally { await service.dispose(); }
  });

  it("preserves bundled Git config isolation without forwarding inherited pager commands", async () => {
    const context = fixture();
    vi.stubEnv("GIT_PAGER", "firefly-public-never-execute");
    vi.stubEnv("PAGER", "firefly-public-never-execute");
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "bundled", version: "public-fixture", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" } }) });
    try {
      const status = await service.getStatusForSession(context.session.id);
      expect(status.state).toBe(process.platform === "win32" ? "ready" : "error");
      if (process.platform !== "win32") expect(status.message).toMatch(/GIT_CONFIG_GLOBAL/);
    } finally { await service.dispose(); }
  });

  it("continues rejecting arbitrary explicit global configuration paths", async () => {
    const context = fixture();
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "bundled", version: "public-fixture", env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(context.root, "must-not-read-config") } }) });
    try {
      const status = await service.getStatusForSession(context.session.id);
      expect(status.state).toBe("error");
      expect(status.message).toMatch(/GIT_CONFIG_GLOBAL/);
      expect(fs.existsSync(path.join(context.root, "must-not-read-config"))).toBe(false);
    } finally { await service.dispose(); }
  });
});
