import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../tooling/registry/tool-registry";
import type { ToolContext } from "../../tooling/registry/tool-context";

const { state, registry } = vi.hoisted(() => ({
  state: { workspace: "", userData: "", liveLevel: "full" },
  registry: new Map<string, ToolDefinition>(),
}));
vi.mock("../../platform/permission/permission", () => ({ getCurrentLevel: () => state.liveLevel }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => state.userData, getPath: () => state.userData } }));
vi.mock("../../tooling/registry/tool-registry", () => ({ toolRegistry: { register: (t: ToolDefinition) => registry.set(t.id, t) } }));
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "UTC" }));
vi.mock("../../model/vision/vision-captioner", () => ({ captionImage: vi.fn(async () => "native image") }));
vi.mock("../../model/config/model-settings", () => ({ loadModelSettings: () => ({}), resolveModelSettingsProfile: () => ({}) }));
vi.mock("../../model/vision/image-router", () => ({ resolveCaptionVisionConfig: () => ({ ok: true, config: {} }) }));
const spawnMock = vi.fn();
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import "./fs-tools";
import { registerLifeTools } from "./life-tools";
registerLifeTools();

let fixture: string;
beforeEach(() => {
  state.liveLevel = "full";
  spawnMock.mockReset();
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-handle-callers-"));
  state.workspace = path.join(fixture, "workspace");
  state.userData = path.join(fixture, "userdata");
  fs.mkdirSync(state.workspace);
  fs.mkdirSync(state.userData);
  fs.writeFileSync(path.join(state.workspace, "file.txt"), "disk sentinel");
});
afterEach(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
  vi.clearAllMocks();
});

it("unrestricted full write preserves direct filesystem output and never spawns the helper", async () => {
  const file = path.join(state.workspace, "file.txt");
  const result = JSON.parse(await registry.get("write_file")!.execute(
    { path: file, content: "full direct", append: true },
    { userQuery: "full", fileAccessLevel: "full" },
  ));
  expect(result.success).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe("disk sentinel\nfull direct");
  expect(spawnMock).not.toHaveBeenCalled();
});

it("read-only allows direct reads and rejects writes without spawning the helper", async () => {
  const file = path.join(state.workspace, "file.txt");
  const ctx: ToolContext = { userQuery: "read", resolvedWorkspaceRoot: state.workspace, fileAccessLevel: "read-only" };
  const readResult = JSON.parse(await registry.get("read_file")!.execute({ path: file }, ctx));
  expect(readResult.content).toContain("disk sentinel");
  await expect(registry.get("write_file")!.execute({ path: file, content: "blocked" }, ctx))
    .rejects.toMatchObject({ code: "E_FILESYSTEM_READ_ONLY", category: "permission_denied" });
  expect(fs.readFileSync(file, "utf8")).toBe("disk sentinel");
  expect(spawnMock).not.toHaveBeenCalled();
});
