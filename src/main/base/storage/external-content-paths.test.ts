import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExternalContentPaths, resolvePackagedSkillDirectory, findPromptPath, findSkillPath, resolveSkillScanSources } from "./external-content-paths";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "content-location-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function create(file: string) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "fixture-content"); }
describe("content locations", () => {
    it.each([true, false])("resolves packaged=%s without coupling editable content to asar", isPackaged => {
        const install = join(root, "distribution");
        const user = join(root, "profile");
        const appPath = isPackaged ? join(install, "resources", "app.asar") : install;
        expect(resolveExternalContentPaths({ isPackaged, appPath, executablePath: join(install, "desktop.exe"), userDataPath: user })).toEqual({
            installRoot: install, promptDirectories: isPackaged ? [join(user, "prompts"), join(install, "prompts")] : [join(install, "prompts")],
            builtinSkillDirectory: join(install, "skills"), userSkillDirectories: [join(user, "skills")],
        });
        const canonical = isPackaged ? join(install, "resources", "firefly-skills", "skills") : join(install, "vendor", "firefly-skills", "skills");
        expect(resolvePackagedSkillDirectory({ installRoot: install }, { isPackaged, resourcesPath: join(install, "resources"), existsSync: candidate => candidate === canonical })).toEqual(canonical);
    });
    it("chooses current user prompts over bundled prompts without substituting skill identities", () => {
        const user = join(root, "overrides");
        const bundled = join(root, "bundled");
        create(join(bundled, "assistant.md"));
        create(join(bundled, "canvas", "SKILL.md"));
        create(join(user, "calendar", "SKILL.md"));
        expect(findPromptPath("assistant.md", [user, bundled])).toEqual(join(bundled, "assistant.md"));
        create(join(user, "assistant.md"));
        expect(findPromptPath("assistant.md", [user, bundled])).toEqual(join(user, "assistant.md"));
        const paths = { builtinSkillDirectory: bundled, userSkillDirectories: [user] };
        expect(findSkillPath("canvas", "SKILL.md", paths)).toEqual(join(bundled, "canvas", "SKILL.md"));
        expect(findSkillPath("calendar", "SKILL.md", paths)).toEqual(join(user, "calendar", "SKILL.md"));
        expect(findSkillPath("absent", "SKILL.md", paths)).toBeNull();
    });
    it("resolves assets from the highest-priority user source", () => {
        const roots = ["builtin", "local", "profile"].map(folder => join(root, folder));
        for (const folder of roots)
            create(join(folder, "slides", "assets", "theme.json"));
        expect(findSkillPath("slides", join("assets", "theme.json"), { builtinSkillDirectory: roots[0], userSkillDirectories: roots.slice(1) })).toEqual(join(roots[2], "slides", "assets", "theme.json"));
    });
    it("deduplicates scan roots and retains their low-to-high source ordering", () => {
        const builtin = join(root, "builtin");
        const user = join(root, "profile");
        mkdirSync(builtin);
        expect(resolveSkillScanSources({ builtinSkillDirectory: builtin, userSkillDirectories: [builtin, user] })).toEqual([{ directory: builtin, source: "builtin" }, { directory: user, source: "user" }]);
    });
});
