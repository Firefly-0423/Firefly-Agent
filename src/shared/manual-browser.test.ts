import { describe, expect, it } from "vitest";
import { BROWSER_PUBLIC_SCOPE, MANUAL_BROWSER_WORKSPACE_IPC } from "./manual-browser";

describe("BROWSER_PUBLIC_SCOPE", () => {
  it("lists the exact public destinations without wildcards", () => {
    expect(BROWSER_PUBLIC_SCOPE.hosts).toEqual([
      "example.com",
      "github.com",
      "github.githubassets.com",
      "avatars.githubusercontent.com",
    ]);
    for (const host of BROWSER_PUBLIC_SCOPE.hosts) expect(host).not.toMatch(/[*?]/);
  });

  it("grants the four bounded manual actions and no mode", () => {
    expect(BROWSER_PUBLIC_SCOPE.actions).toEqual(["navigate", "observe", "click", "type"]);
    expect(BROWSER_PUBLIC_SCOPE.mode).toBeUndefined();
    expect(BROWSER_PUBLIC_SCOPE.web).toBeUndefined();
  });

  it("is deeply frozen so renderer cannot widen it", () => {
    expect(Object.isFrozen(BROWSER_PUBLIC_SCOPE)).toBe(true);
    expect(Object.isFrozen(BROWSER_PUBLIC_SCOPE.hosts)).toBe(true);
    expect(Object.isFrozen(BROWSER_PUBLIC_SCOPE.actions)).toBe(true);
  });
});

describe("MANUAL_BROWSER_WORKSPACE_IPC", () => {
  it("exposes the workspace channel names and is frozen", () => {
    expect(MANUAL_BROWSER_WORKSPACE_IPC).toEqual({
      availability: "browser:workspace:availability",
      permission: "browser:workspace:permission",
      command: "browser:workspace:command",
      changed: "browser:workspace:changed",
      toolsChanged: "browser:workspace:tools-changed",
    });
    expect(Object.isFrozen(MANUAL_BROWSER_WORKSPACE_IPC)).toBe(true);
  });

  it("keeps every channel unique and namespaced", () => {
    const channels = Object.values(MANUAL_BROWSER_WORKSPACE_IPC);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel.startsWith("browser:workspace:")).toBe(true);
  });
});
