import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { ObsidianError, ObsidianWorkspaceService, type ObsidianEditRequest } from "./obsidian-workspace-service";
import { contentHash, extractHeadings } from "./obsidian-markdown";

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
let folder: string;
let workspace: ObsidianWorkspaceService;
const notePath = "research/orbit.md";
const initialNote = "# Observatory\n\n## Schedule\n\nWatch the sky.\n";
function seed(relative: string, text: string) {
  const file = join(folder, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}
const diskText = (relative = notePath) => readFileSync(join(folder, relative), "utf8");
async function refuses(operation: Promise<unknown>, code: string, message?: string) {
  await expect(operation).rejects.toBeInstanceOf(ObsidianError);
  await expect(operation).rejects.toMatchObject({ code, ...(message ? { message: `[${code}] ${message}` } : {}) });
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "firefly-own-vault-"));
  workspace = new ObsidianWorkspaceService();
  workspace.configure({ vaultPath: folder, enabled: true });
});
afterEach(() => {
  expect(dirname(resolve(folder))).toEqual(resolve(tmpdir()));
  expect(basename(folder)).toMatch(/^firefly-own-vault-/);
  rmSync(folder, { force: true, recursive: true });
});

describe("vault concurrency contract", () => {
  it.each([
    { operation: "append", content: "An addition" },
    { operation: "replace_section", headingPath: ["Observatory", "Schedule"], content: "A revision" },
    { operation: "append_to_section", headingPath: ["Observatory", "Schedule"], content: "Another item" },
    { operation: "replace_file", content: "A replacement" },
  ])("refuses an unlocked $operation and retains the original bytes", async (change) => {
    seed(notePath, initialNote);
    await refuses(workspace.edit({ ...change, path: notePath } as ObsidianEditRequest), "CONTENT_HASH_REQUIRED",
      `修改已有文件必须携带 expectedContentHash（先 read_file 获取），操作: ${change.operation}，文件: ${notePath}`);
    expect(diskText()).toEqual(initialNote);
  });

  it("reports a stale hash with the current digest and leaves the note untouched", async () => {
    seed(notePath, initialNote);
    const stale = digest("An earlier draft\n");
    const edit = workspace.edit({ operation: "replace_file", path: notePath,
      expectedContentHash: stale, content: "A newer draft\n" });
    await refuses(edit, "CONTENT_CONFLICT", `文件 ${notePath} 已被外部修改，请重新读取后再编辑。`);
    await expect(edit).rejects.toMatchObject({ details: { current: digest(initialNote), expected: stale } });
    expect(diskText()).toEqual(initialNote);
  });

  it("uses the read digest to replace the complete note and returns the new digest", async () => {
    seed(notePath, initialNote);
    const read = await workspace.readFile({ path: notePath });
    expect(read.contentHash).toEqual(digest(initialNote));
    const revised = "# Observatory log\nVisible planets: 土星\n";
    expect(await workspace.edit({ expectedContentHash: read.contentHash, path: notePath,
      operation: "replace_file", content: revised })).toEqual({
      operation: "replace_file", path: notePath, newContentHash: digest(revised), bytesWritten: Buffer.byteLength(revised),
    });
    expect(diskText()).toEqual(revised);
  });

  it.each(["# Almanac\n", "# Almanac"])("appends with one separating newline to %j", async (original) => {
    seed(notePath, original);
    const read = await workspace.readFile({ path: notePath });
    const result = await workspace.edit({ path: notePath, expectedContentHash: read.contentHash,
      content: "Next observation  \n", operation: "append" });
    const expected = "# Almanac\nNext observation\n";
    expect(diskText()).toEqual(expected);
    expect(result.newContentHash).toEqual(digest(expected));
  });

  it("rejects replacement of a missing nested file without creating its parent", async () => {
    const absent = "unopened/archive/meteor.md";
    await refuses(workspace.edit({ operation: "replace_file", path: absent,
      content: "meteor", expectedContentHash: "unavailable-revision" }), "PATH_NOT_FOUND", `文件不存在: ${absent}`);
    expect(existsSync(join(folder, "unopened"))).toBe(false);
  });
});

describe("creation and private directory boundaries", () => {
  it("creates a nested note and describes exactly the bytes written", async () => {
    const content = "# First observation\n";
    const result = await workspace.edit({ content, path: notePath, operation: "create" });
    expect(result).toEqual({ path: notePath, operation: "create", newContentHash: digest(content), bytesWritten: Buffer.byteLength(content) });
    expect(existsSync(join(folder, notePath))).toEqual(true);
    expect(diskText()).toEqual(content);
  });

  it("refuses create on an occupied path even if different content is supplied", async () => {
    seed(notePath, initialNote);
    await refuses(workspace.edit({ path: notePath, operation: "create", content: "Discard the log" }), "PATH_ALREADY_EXISTS",
      `文件已存在，create 不覆盖: ${notePath}。如需修改请先 read_file 再用对应编辑操作。`);
    expect(diskText()).toEqual(initialNote);
  });

  it.each([".firefly", ".obsidian"])("rejects reads and creates within %s", async (privateDir) => {
    const privateFile = `${privateDir}/preferences.json`;
    await refuses(workspace.readFile({ path: privateFile }), "PATH_OUTSIDE_VAULT",
      `禁止操作 ${privateDir}/ 目录: ${privateFile}`);
    const newFile = `${privateDir}/unwanted.md`;
    await refuses(workspace.edit({ path: newFile, content: "private", operation: "create" }), "PATH_OUTSIDE_VAULT",
      `禁止操作 ${privateDir}/ 目录: ${newFile}`);
    expect(existsSync(join(folder, newFile))).toBe(false);
  });

  it("lists only public notes in sorted path order during recursive traversal", async () => {
    seed(".firefly/hidden-note.md", "hidden application state");
    seed(".obsidian/hidden-note.md", "hidden editor state");
    seed("zodiac/end.md", "last note");
    seed("astronomy/start.markdown", "first note");
    const paths = (await workspace.listFiles({ recursive: true })).map((entry) => entry.path);
    expect(paths).toEqual(["astronomy/start.markdown", "zodiac/end.md"]);
    expect(paths.some((relative) => relative.startsWith(".firefly/"))).toEqual(false);
  });
});

describe("section boundaries exposed to vault clients", () => {
  const prefix = "Preamble.\n# Observatory\nIntroduction.\n";
  const section = "## Schedule\nWatch the sky.\n";
  const child = "### Equipment\nBring binoculars.\n";
  const sibling = "## Results\nSaturn observed.\n";
  const headingPath = ["Observatory", "Schedule"];
  const original = prefix + section + child + sibling;

  it.each([false, true])("reads the selected section with includeChildren=%s", async (includeChildren) => {
    seed(notePath, original);
    expect(await workspace.readSection({ path: notePath, headingPath, includeChildren })).toEqual({
      path: notePath, headingPath, headingDepth: 2,
      content: (section + (includeChildren ? child : "")).trimEnd(),
      contentHash: digest((section + (includeChildren ? child : "")).trimEnd()),
    });
    expect(diskText()).toBe(original);
  });

  it.each([false, true])("replaces exactly the selected section with includeChildren=%s", async (includeChildren) => {
    seed(notePath, original);
    const replacement = "## Schedule\nWatch tomorrow.\n";
    const expected = prefix + replacement + (includeChildren ? "" : child) + sibling;
    const result = await workspace.edit({ operation: "replace_section", path: notePath, headingPath,
      includeChildren, content: replacement, expectedContentHash: digest(original) });
    expect(diskText()).toBe(expected);
    expect(result).toEqual({ operation: "replace_section", path: notePath,
      newContentHash: digest(expected), bytesWritten: Buffer.byteLength(expected) });
  });

  it("appends after descendants and before the next sibling", async () => {
    seed(notePath, original);
    const expected = prefix + section + child.trimEnd() + "\n\nCheck the forecast.\n" + sibling;
    const result = await workspace.edit({ operation: "append_to_section", path: notePath, headingPath,
      content: "Check the forecast.", expectedContentHash: digest(original) });
    expect(diskText()).toBe(expected);
    expect(result).toEqual({ operation: "append_to_section", path: notePath,
      newContentHash: digest(expected), bytesWritten: Buffer.byteLength(expected) });
  });

  it("reads the final section through the end of the document", async () => {
    seed(notePath, original.trimEnd());
    const result = await workspace.readSection({ path: notePath, headingPath: ["Observatory", "Results"], includeChildren: true });
    expect(result.content).toBe("## Results\nSaturn observed.");
  });

  it.each([
    ["# Observatory\n", "HEADING_NOT_FOUND"],
    ["# Observatory\n## Schedule\nFirst.\n## Schedule\nSecond.\n", "AMBIGUOUS_HEADING"],
  ])("retains lookup errors for %j", async (text, code) => {
    seed(notePath, text);
    await refuses(workspace.readSection({ path: notePath, headingPath }), code);
    await refuses(workspace.edit({ operation: "replace_section", path: notePath, headingPath,
      content: "Replacement.\n", expectedContentHash: digest(text) }), code);
    await refuses(workspace.edit({ operation: "append_to_section", path: notePath, headingPath,
      content: "Addition.\n", expectedContentHash: digest(text) }), code);
    expect(diskText()).toBe(text);
  });
});

describe("markdown values exposed to vault clients", () => {
  it("hashes original line endings deterministically rather than normalizing them", () => {
    const text = "# Telescope\n";
    expect(contentHash(text)).toEqual(digest(text));
    expect(contentHash(text)).toEqual(contentHash(text));
    expect(contentHash(text)).not.toBe(contentHash("# Telescope\r\n"));
  });

  it("resets heading ancestry when the next top-level heading starts", () => {
    const paths = extractHeadings("# Night sky\n\n## Equipment\n\nBring binoculars.\n\n# Sunrise\n").map((heading) => heading.path);
    expect(paths).toEqual([["Night sky"], ["Night sky", "Equipment"], ["Sunrise"]]);
  });
});
