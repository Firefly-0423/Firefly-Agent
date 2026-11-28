import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianWorkspaceService } from "./obsidian-workspace-service";

describe.runIf(process.platform === "win32")("Obsidian protected directories on Windows", () => {
  let root: string;
  let service: ObsidianWorkspaceService;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-protected-paths-"));
    service = new ObsidianWorkspaceService();
    service.configure({ enabled: true, vaultPath: root });
    for (const directory of [".obsidian", ".firefly", "notes/.OBSIDIAN", "notes/.Firefly"]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(path.join(root, directory, "private.md"), "private");
    }
    fs.writeFileSync(path.join(root, "public.md"), "public");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([".OBSIDIAN", ".Firefly", "notes/.OBSIDIAN", "notes/.Firefly"])("refuses reads and writes through %s aliases", async directory => {
    await expect(service.listFiles({ relativeDir: directory })).rejects.toMatchObject({ code: "PATH_OUTSIDE_VAULT" });
    await expect(service.readFile({ path: `${directory}/private.md` })).rejects.toMatchObject({ code: "PATH_OUTSIDE_VAULT" });
    await expect(service.edit({ operation: "create", path: `${directory}/new.md`, content: "changed" })).rejects.toMatchObject({ code: "PATH_OUTSIDE_VAULT" });
    expect(fs.existsSync(path.join(root, directory, "new.md"))).toBe(false);
  });

  it("does not list internal directories with mixed case names", async () => {
    expect((await service.listFiles()).map(file => file.path)).toEqual(["public.md"]);
  });
});
