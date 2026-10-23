import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { within } from "../runtime-profile";

const modules = import.meta.glob<typeof import("./testing/external-fixtures")>("./testing/external-fixtures.ts");
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
async function fixtures() {
  const load = modules["./testing/external-fixtures.ts"];
  expect(load, "External tests must provide a fully isolated storage and synthetic network fixture").toBeTypeOf("function");
  return load();
}

it("isolated_root_only owns all test storage and preserves the production sentinel on dispose", async () => {
  const { isolatedStorageContext } = await fixtures();
  const { storage, root, productionSentinelRoot, dispose } = isolatedStorageContext();
  cleanup.push(() => fs.rmSync(productionSentinelRoot, { recursive: true, force: true }), dispose);
  const sentinel = path.join(productionSentinelRoot, "keep.txt");
  fs.writeFileSync(sentinel, "synthetic production sentinel");
  expect(storage.profile.kind).toBe("test");
  expect(storage.profile.isolationRoot).toBe(root);
  expect(path.dirname(root)).toBe(path.dirname(productionSentinelRoot));
  const targets = [storage.profile.appData, storage.profile.userData, storage.profile.sessionData, storage.profile.logs,
    storage.configRoot, storage.dataRoot, storage.stateRoot, storage.cacheRoot, storage.logsRoot, storage.sessionRoot,
    ...Object.values(storage.memory), ...Object.values(storage.files)];
  for (const target of targets) {
    expect(within(root, target)).toBe(true);
    expect(within(productionSentinelRoot, target) || within(target, productionSentinelRoot)).toBe(false);
  }
  expect(within(root, productionSentinelRoot) || within(productionSentinelRoot, root)).toBe(false);
  fs.mkdirSync(storage.cacheRoot, { recursive: true });
  fs.writeFileSync(path.join(storage.cacheRoot, "test-only.txt"), "isolated");
  dispose();
  dispose();
  expect(fs.existsSync(root)).toBe(false);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("synthetic production sentinel");
});

it("isolated_root_only creates distinct independent roots without initializing global storage", async () => {
  const { isolatedStorageContext } = await fixtures();
  const one = isolatedStorageContext();
  const two = isolatedStorageContext();
  cleanup.push(() => fs.rmSync(one.productionSentinelRoot, { recursive: true, force: true }), one.dispose,
    () => fs.rmSync(two.productionSentinelRoot, { recursive: true, force: true }), two.dispose);
  expect(one.root).not.toBe(two.root);
  expect(one.productionSentinelRoot).not.toBe(two.productionSentinelRoot);
  one.dispose();
  expect(fs.existsSync(two.root)).toBe(true);
});

it("synthetic_fixture serves only generated instruction text with verifiable permissive license evidence", async () => {
  const { createExternalFixture } = await fixtures();
  const fixture = createExternalFixture();
  expect(Object.keys(fixture.expectedFiles).sort()).toEqual(["LICENSE", "SKILL.md", "references/guide.md"]);
  expect(fixture.expectedFiles["SKILL.md"]).toContain("synthetic-text");
  expect(fixture.review.reviewer).toBe("synthetic-test-fixture");
  expect(fixture.review.compatibility).toBe("instruction-only");
  expect(fixture.review.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(fixture.review.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  const license = fixture.review.licenses[0];
  expect(license.spdx).toBe("MIT");
  expect(license.covers.sort()).toEqual(Object.keys(fixture.expectedFiles).sort());
  expect(license.sha256).toBe(createHash("sha256").update(fixture.expectedFiles["LICENSE"]).digest("hex"));
  const metadataUrl = "https://api.github.com/repos/openai/plugins";
  const metadata = await fixture.fetch(metadataUrl);
  expect(await metadata.json()).toMatchObject({ default_branch: "main" });
  const commit = await fixture.fetch(metadataUrl + "/commits/main");
  expect(await commit.json()).toMatchObject({ sha: fixture.review.commit });
  expect(fixture.calls).toEqual([metadataUrl, metadataUrl + "/commits/main"]);
  const outside = await fixture.fetch("https://example.invalid/unexpected");
  expect(outside.status).toBe(404);
  expect(fixture.calls.at(-1)).toBe("https://example.invalid/unexpected");
});
