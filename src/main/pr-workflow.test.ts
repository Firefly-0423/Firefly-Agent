import assert from "node:assert/strict";
import fs from "node:fs";
import { it as test } from "vitest";
import YAML from "yaml";

// The repo keeps two long-lived branches: every PR lands on firefly-demo, which the owner then merges into main.
// Version integration branches (dev/firefly-1.2.0 and later) also run the full Test workflow on push and on PRs into them.
const workflowBranches: Array<[string, string, string[]]> = [
  ["test.yml", "windows-latest", ["main", "firefly-demo", "dev/**"]],
  ["plugin-sdk.yml", "ubuntu-latest", ["main", "firefly-demo"]],
];
for (const [file, runner, branches] of workflowBranches) {
  test(`${file} runs on ${branches.join(", ")} with the existing safe triggers and permissions`, () => {
    const workflow = YAML.parse(fs.readFileSync(`.github/workflows/${file}`, "utf8"));
    assert.deepEqual(workflow.on.pull_request.branches, branches);
    assert.deepEqual(workflow.on.push.branches, branches);
    assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.equal(Object.values(workflow.jobs)[0]["runs-on"], runner);
  });
}

test("Windows Test builds and selects the verified native history helper before running the suite", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/test.yml", "utf8"));
  const steps = workflow.jobs.test.steps;
  const buildIndex = steps.findIndex((step: { run?: string }) => step.run?.includes("pnpm run build:history-helpers"));
  const testIndex = steps.findIndex((step: { run?: string }) => step.run === "./scripts/ci/run-vitest.ps1");
  assert.ok(buildIndex >= 0);
  assert.ok(buildIndex < testIndex);
  assert.match(steps[buildIndex].run, /FIREFLY_HISTORY_PRESENCE_TEST_HELPER/);
  assert.match(steps[buildIndex].run, /native\/target\/release\/firefly-history-presence\.exe/);
  assert.match(steps[buildIndex].run, /GITHUB_ENV/);
  assert.equal(steps[buildIndex]["continue-on-error"], undefined);
});

test("the promo site deploys to Cloudflare from main only, with read-only repo access and the token kept in secrets", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/site.yml", "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const steps = workflow.jobs.deploy.steps as Array<{ run?: string; uses?: string; with?: Record<string, string> }>;
  const build = steps.findIndex(step => step.run === "pnpm run build:site");
  const deploy = steps.findIndex(step => step.uses?.startsWith("cloudflare/wrangler-action@"));
  assert.ok(build >= 0 && deploy > build);
  assert.deepEqual(steps[deploy].with, {
    apiToken: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    accountId: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    wranglerVersion: steps[deploy].with?.wranglerVersion,
    command: "deploy",
  });
  assert.match(steps[deploy].with?.wranglerVersion ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(workflow.jobs.deploy.environment.url, "https://hotarufirefly.online/");
});

test("wrangler.jsonc serves only the built site, on the project's own domain", () => {
  const config = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.main, undefined);
  assert.deepEqual(config.assets, { directory: "./dist/site" });
  assert.deepEqual(config.routes, [
    { pattern: "hotarufirefly.online", custom_domain: true },
    { pattern: "www.hotarufirefly.online", custom_domain: true },
  ]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test("the plugin SDK publishes to npm only from a version tag, through trusted publishing", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/plugin-sdk-publish.yml", "utf8"));
  assert.deepEqual(workflow.on, { push: { tags: ["plugin-sdk-v*"] } });
  assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
  const steps = workflow.jobs.publish.steps as Array<{ run?: string; env?: Record<string, string>; "working-directory"?: string }>;
  const index = (pattern: RegExp) => steps.findIndex(step => pattern.test(step.run ?? ""));
  assert.ok(index(/GITHUB_REF_NAME#plugin-sdk-v/) >= 0);
  // Each step must exist before its order means anything: a missing step's index is -1, which is "before" everything.
  const check = index(/^pnpm run check:plugin-sdk$/), examples = index(/^pnpm run test:plugin-examples$/), publish = index(/^npm publish --access public$/);
  assert.ok(check >= 0 && examples >= 0 && publish >= 0, JSON.stringify({ check, examples, publish }));
  assert.ok(check < publish && examples < publish);
  assert.equal(steps[publish]["working-directory"], "plugin-sdk");
  // No npm token anywhere: publishing relies on the OIDC id-token.
  assert.doesNotMatch(fs.readFileSync(".github/workflows/plugin-sdk-publish.yml", "utf8"), /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  const sdk = JSON.parse(fs.readFileSync("plugin-sdk/package.json", "utf8"));
  assert.equal(sdk.name, "@firefly_wu/plugin-sdk");
  assert.equal(sdk.private, undefined);
  assert.equal(sdk.repository.url, "git+https://github.com/Firefly-0423/Firefly-Agent.git");
});

test("every workflow installs the pinned pnpm and the locked dependencies", () => {
  const packageManager = JSON.parse(fs.readFileSync("package.json", "utf8")).packageManager;
  assert.equal(packageManager, "pnpm@12.10.1");
  for (const file of fs.readdirSync(".github/workflows").filter(name => name.endsWith(".yml"))) {
    const workflow = YAML.parse(fs.readFileSync(`.github/workflows/${file}`, "utf8"));
    const runs = (Object.values(workflow.jobs)[0] as { steps: Array<{ run?: string }> }).steps.map(step => step.run ?? "");
    const pnpm = runs.indexOf(`npm install --global ${packageManager}`);
    const install = runs.indexOf("pnpm install --frozen-lockfile");
    assert.ok(pnpm >= 0 && install > pnpm, `${file} installs ${packageManager} before a frozen install`);
    assert.ok(!runs.some(run => /npm ci|npx/.test(run)), `${file} no longer installs or runs tools through npm`);
  }
});
