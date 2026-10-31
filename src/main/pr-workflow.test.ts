import assert from "node:assert/strict";
import fs from "node:fs";
import { it as test } from "vitest";
import YAML from "yaml";

for (const [file, runner] of [["test.yml", "windows-latest"], ["plugin-sdk.yml", "ubuntu-latest"]]) {
  // The repo keeps two long-lived branches: every PR lands on firefly-demo, which the owner then merges into main.
  test(`${file} covers main and firefly-demo with the existing safe triggers and permissions`, () => {
    const workflow = YAML.parse(fs.readFileSync(`.github/workflows/${file}`, "utf8"));
    assert.deepEqual(workflow.on.pull_request.branches, ["main", "firefly-demo"]);
    assert.deepEqual(workflow.on.push.branches, ["main", "firefly-demo"]);
    assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.equal(Object.values(workflow.jobs)[0]["runs-on"], runner);
  });
}

test("Windows Test builds and selects the verified native history helper before running the suite", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/test.yml", "utf8"));
  const steps = workflow.jobs.test.steps;
  const buildIndex = steps.findIndex((step: { run?: string }) => step.run?.includes("npm run build:history-helpers"));
  const testIndex = steps.findIndex((step: { run?: string }) => step.run === "./scripts/ci/run-vitest.ps1");
  assert.ok(buildIndex >= 0);
  assert.ok(buildIndex < testIndex);
  assert.match(steps[buildIndex].run, /FIREFLY_HISTORY_PRESENCE_TEST_HELPER/);
  assert.match(steps[buildIndex].run, /native\/target\/release\/firefly-history-presence\.exe/);
  assert.match(steps[buildIndex].run, /GITHUB_ENV/);
  assert.equal(steps[buildIndex]["continue-on-error"], undefined);
});

test("the plugin SDK publishes to npm only from a version tag, through trusted publishing", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/plugin-sdk-publish.yml", "utf8"));
  assert.deepEqual(workflow.on, { push: { tags: ["plugin-sdk-v*"] } });
  assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
  const steps = workflow.jobs.publish.steps as Array<{ run?: string; env?: Record<string, string>; "working-directory"?: string }>;
  const index = (pattern: RegExp) => steps.findIndex(step => pattern.test(step.run ?? ""));
  assert.ok(index(/GITHUB_REF_NAME#plugin-sdk-v/) >= 0);
  assert.ok(index(/npm run check:plugin-sdk/) < index(/npm publish/));
  assert.ok(index(/npm run test:plugin-examples/) < index(/npm publish/));
  assert.equal(steps[index(/npm publish/)]["working-directory"], "plugin-sdk");
  // No npm token anywhere: publishing relies on the OIDC id-token.
  assert.doesNotMatch(fs.readFileSync(".github/workflows/plugin-sdk-publish.yml", "utf8"), /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  const sdk = JSON.parse(fs.readFileSync("plugin-sdk/package.json", "utf8"));
  assert.equal(sdk.name, "@firefly_wu/plugin-sdk");
  assert.equal(sdk.private, undefined);
  assert.equal(sdk.repository.url, "git+https://github.com/Firefly-0423/Firefly-Agent.git");
});
