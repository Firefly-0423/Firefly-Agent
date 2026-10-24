import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { migrateStagedExternalContent, type StagedContentMigrationInput } from "./external-content-migration";
let root: string;
let input: StagedContentMigrationInput;
let staging: string;
const digest = (text: string) => createHash("sha1").update(text).digest("hex");
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const read = (file: string) => readFileSync(file, "utf8");
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "upgrade-content-"));
    const installRoot = join(root, "installation");
    staging = join(root, ".Firefly.content-preserve");
    input = { isPackaged: true, installRoot, manifestFile: join(root, "profile", "content-manifest.json"), promptDirectories: [join(root, "profile", "prompts"), join(installRoot, "prompts")], userSkillDirectories: [join(root, "profile", "skills")] };
    mkdirSync(installRoot);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("installer content recovery", () => {
    it("recovers modified and added prompts while dropping unchanged shipped content", () => {
        write(join(input.installRoot, "prompts", "identity.md"), "bundled revision two");
        write(join(input.installRoot, "prompts", "voice.md"), "updated bundled voice");
        write(input.manifestFile, JSON.stringify({ prompts: { "identity.md": digest("bundled revision one"), "voice.md": digest("original voice") }, skills: {} }));
        write(join(staging, "prompts", "identity.md"), "bundled revision one");
        write(join(staging, "prompts", "voice.md"), "custom speaking style");
        write(join(staging, "prompts", "personal.md"), "personal instruction");
        migrateStagedExternalContent(input);
        expect(existsSync(join(input.promptDirectories[0], "identity.md"))).toEqual(false);
        expect(read(join(input.promptDirectories[0], "voice.md"))).toEqual("custom speaking style");
        expect(read(join(input.promptDirectories[0], "personal.md"))).toEqual("personal instruction");
        expect(existsSync(staging)).toEqual(false);
    });
    it("compares current shipped content when no previous manifest exists", () => {
        write(join(input.installRoot, "prompts", "policy.md"), "bundled policy");
        write(join(staging, "prompts", "policy.md"), "bundled policy");
        write(join(staging, "prompts", "retained.md"), "no longer bundled");
        migrateStagedExternalContent(input);
        expect(existsSync(join(input.promptDirectories[0], "policy.md"))).toEqual(false);
        expect(read(join(input.promptDirectories[0], "retained.md"))).toEqual("no longer bundled");
    });
    it("preserves existing user skill files while filling nested assets", () => {
        const destination = join(input.userSkillDirectories[0], "custom-tool");
        write(join(destination, "SKILL.md"), "current user definition");
        write(join(staging, "skills", "custom-tool", "SKILL.md"), "outdated definition");
        write(join(staging, "skills", "custom-tool", "media", "cover.png"), "asset bytes");
        migrateStagedExternalContent(input);
        expect(read(join(destination, "SKILL.md"))).toEqual("current user definition");
        expect(read(join(destination, "media", "cover.png"))).toEqual("asset bytes");
    });
    it("hashes shipped prompt and nested skill content for the next upgrade", () => {
        write(join(input.installRoot, "prompts", "policy.md"), "official policy");
        write(join(input.installRoot, "skills", "example-tool", "SKILL.md"), "official skill");
        migrateStagedExternalContent(input);
        expect(JSON.parse(read(input.manifestFile))).toEqual({ prompts: { "policy.md": digest("official policy") }, skills: { "example-tool/SKILL.md": digest("official skill") } });
    });
    it("does not run recovery or write a manifest for development builds", () => {
        write(join(staging, "prompts", "custom.md"), "pending recovery");
        migrateStagedExternalContent({ ...input, isPackaged: false });
        expect(existsSync(staging)).toEqual(true);
        expect(existsSync(input.manifestFile)).toEqual(false);
    });
    it("honors the explicit manifest owner and staging opt-out", () => {
        const manifestFile = join(root, "state", "content-manifest.json");
        write(join(staging, "prompts", "private.md"), "pending user override");
        migrateStagedExternalContent({ ...input, manifestFile, allowStagedMigration: false });
        expect(existsSync(manifestFile)).toEqual(true);
        expect(existsSync(input.manifestFile)).toEqual(false);
        expect(read(join(staging, "prompts", "private.md"))).toEqual("pending user override");
        expect(existsSync(join(input.promptDirectories[0], "private.md"))).toEqual(false);
    });
    it("retains malformed manifests and backs up a valid previous manifest", () => {
        write(input.manifestFile, "{broken-json");
        migrateStagedExternalContent(input);
        expect(read(input.manifestFile)).toEqual("{broken-json");
        const previous = { prompts: { "archived.md": digest("archived version") }, skills: {} };
        write(input.manifestFile, JSON.stringify(previous));
        migrateStagedExternalContent(input);
        expect(JSON.parse(read(input.manifestFile + ".bak"))).toEqual(previous);
    });
});
