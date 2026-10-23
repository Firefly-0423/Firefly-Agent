import assert from "node:assert/strict";
import fs from "node:fs";
import { it as test } from "vitest";
import YAML from "yaml";

for (const [file, runner] of [["test.yml", "windows-latest"], ["plugin-sdk.yml", "ubuntu-latest"]]) {
  test(`${file} covers release and stacked PR bases with the existing safe triggers and permissions`, () => {
    const workflow = YAML.parse(fs.readFileSync(`.github/workflows/${file}`, "utf8"));
    assert.deepEqual(workflow.on.pull_request.branches, ["main", "chore/project-structure-finalize", "firefly-mini-v1.1.x"]);
    assert.deepEqual(workflow.on.push.branches, ["main", "firefly-mini-v1.1.x"]);
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
