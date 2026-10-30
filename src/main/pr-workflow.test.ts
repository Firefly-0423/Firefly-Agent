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

test("Pages publishes the promo site from main only, with the narrow Pages permissions", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/pages.yml", "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read", pages: "write", "id-token": "write" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const steps = workflow.jobs.build.steps as Array<{ run?: string; uses?: string; with?: { path?: string } }>;
  assert.ok(steps.some(step => step.run === "npm run build:site"));
  assert.equal(steps.find(step => step.uses?.startsWith("actions/upload-pages-artifact@"))?.with?.path, "dist/site");
  assert.deepEqual(workflow.jobs.deploy.needs, "build");
  assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
});
