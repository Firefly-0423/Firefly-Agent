import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyVendorSkills } from "../../test-utils/vendor-skill-source";
import { scanSkills } from "./skill-scanner";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("delivers the licensed Firefly adaptation without foreign host hooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-self-source-"));
  roots.push(root);
  copyVendorSkills(root);
  const directory = path.join(root, "self-improving-agent");
  const body = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8");
  expect(body).toContain("Firefly-maintained");
  expect(body).toContain("LRN-YYYYMMDD-XXX");
  expect(body).toContain("ERR-YYYYMMDD-XXX");
  expect(body).toContain("FEAT-YYYYMMDD-XXX");
  expect(body).not.toContain("CLAUDE_PLUGIN_ROOT");
  expect(body).not.toContain("../self-healing/SKILL.md");
  expect(fs.existsSync(path.join(directory, "hooks"))).toBe(false);
  expect(fs.readFileSync(path.join(directory, "LICENSE"), "utf8")).toContain("Peter Skøtt Pedersen");
  const skill = scanSkills(root, "user").find(skill => skill.id === "self-improving-agent")!;
  expect(skill.modes).toEqual(["work", "code"]);
  expect(skill.effectKind).toBeUndefined();
  for (const name of ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md", "SKILL-TEMPLATE.md"]) {
    expect(fs.statSync(path.join(directory, "firefly-templates", name)).isFile()).toBe(true);
  }
});

it("runs the reviewed extraction helper only in an explicit temporary workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-self-extraction-"));
  roots.push(root);
  const bash = process.env.FIREFLY_TEST_BASH;
  if (!bash || !path.isAbsolute(bash) || !fs.statSync(bash).isFile()) throw new Error("FIREFLY_TEST_BASH must identify the actual Bash fixture");
  copyVendorSkills(path.join(root, "extracted"));
  const script = path.join(root, "extracted/self-improving-agent/scripts/upstream-extract-skill.sh").split(path.sep).join("/");
  const output = path.join(root, "output");
  const run = (...args: string[]) => execFileSync(bash, [script, ...args], {
    cwd: root, timeout: 5000, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, PATH: path.dirname(bash) + path.delimiter + (process.env.PATH ?? "") },
  });
  run("public-learning", "--dry-run", "--output-dir", output.split(path.sep).join("/"));
  expect(fs.existsSync(output)).toBe(false);
  run("public-learning", "--output-dir", output.split(path.sep).join("/"));
  const body = fs.readFileSync(path.join(output, "public-learning/SKILL.md"), "utf8");
  expect(body).toContain("name: public-learning");
  expect(() => run("public-learning", "--output-dir", output.split(path.sep).join("/"))).toThrow();
  expect(fs.readFileSync(path.join(output, "public-learning/SKILL.md"), "utf8")).toBe(body);
  expect(() => run("../escape", "--output-dir", output.split(path.sep).join("/"))).toThrow();
});
