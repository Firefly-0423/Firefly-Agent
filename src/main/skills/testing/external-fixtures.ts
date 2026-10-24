/** Synthetic local-only fixtures. This module does not initialize Main's storage singleton. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveRuntimeProfile } from "../../runtime-profile";
import { createStorageContext, type StorageContext } from "../../storage-context";
import type { ExternalSkillReview } from "../external-types";
import { EXTERNAL_REVIEW_POLICY_VERSION } from "../external-policy";

export function isolatedStorageContext(): {
  storage: StorageContext;
  root: string;
  productionSentinelRoot: string;
  dispose: () => void;
} {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-external-test-")));
  let productionSentinelRoot: string | undefined;
  try {
    productionSentinelRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-external-sentinel-")));
    const profile = resolveRuntimeProfile({
      argv: ["--firefly-profile=test", `--firefly-isolation-root=${root}`],
      env: {},
      isPackaged: false,
      productionAppData: productionSentinelRoot,
    });
    const storage = createStorageContext(profile);
    return {
      storage, root, productionSentinelRoot,
      // Preserve the sentinel so tests can prove it was not touched; its creator/test owns cleanup.
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (productionSentinelRoot !== undefined) fs.rmSync(productionSentinelRoot, { recursive: true, force: true });
    throw error;
  }
}

export function createExternalFixture(): {
  fetch: typeof globalThis.fetch;
  calls: string[];
  review: ExternalSkillReview;
  expectedFiles: Record<string, string>;
} {
  const expectedFiles = {
    "SKILL.md": "---\nname: synthetic-text\ndescription: A generated test instruction Skill.\n---\n\n# Synthetic text\nRead references/guide.md and summarize the supplied text.\n",
    "LICENSE": "MIT License\n\nCopyright (c) 2026 Synthetic Test Authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    "references/guide.md": "# Synthetic guide\n\nUse only the text supplied by the test. No scripts or external resources are required.\n",
  };
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const contentFiles = Object.entries(expectedFiles).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([filePath, text]) => [filePath, sha256(text), Buffer.byteLength(text)]);
  const review: ExternalSkillReview = {
    policyVersion: EXTERNAL_REVIEW_POLICY_VERSION,
    sourceId: "openai", commit: "a".repeat(40), path: "plugins/synthetic/skills/synthetic-text",
    contentSha256: sha256(JSON.stringify(contentFiles)),
    licenses: [{ path: "LICENSE", sha256: sha256(expectedFiles.LICENSE), spdx: "MIT", covers: Object.keys(expectedFiles) }],
    compatibility: "instruction-only", reviewedAt: "2026-10-08T00:00:00.000Z", reviewer: "synthetic-test-fixture",
  };
  const calls: string[] = [];
  const repositoryUrl = "https://api.github.com/repos/openai/plugins";
  const mockFetch: typeof globalThis.fetch = async input => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === repositoryUrl) return Response.json({ default_branch: "main" });
    if (url === repositoryUrl + "/commits/main") return Response.json({ sha: review.commit });
    // Never fall through to the real network, even for an unknown test request.
    return Response.json({ message: "Synthetic fixture route unavailable" }, { status: 404 });
  };
  return { fetch: mockFetch, calls, review, expectedFiles };
}
