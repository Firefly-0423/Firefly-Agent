import { describe, expect, it } from "vitest";
import { isSkillAllowedForRun, registerSkillTools, resetReadRefs } from "./skill-tools";
import { skillRegistry } from "./skill-registry";
import { resolveEffectKind, toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkills } from "./skill-scanner";
import { dispatchToolCall } from "../orchestrator/harness/tool-dispatcher";

describe("Skill run allowlist", () => {
  it("rejects a globally known skill outside the current mode snapshot", () => {
    expect(isSkillAllowedForRun("code-only", new Set(["work-only"]))).toBe(false);
  });

  it("allows a skill included in the current mode snapshot", () => {
    expect(isSkillAllowedForRun("work-only", new Set(["work-only"]))).toBe(true);
  });
});

it("preserves invoke effect classification for body continuation without changing reference reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-skill-effects-"));
  const id = "public-effect-fixture";
  const dir = path.join(root, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: public\n---\nbody`);
  try {
    const skill = scanSkills(root, "user")[0];
    registerSkillTools();
    const invoke = toolRegistry.getById("invoke_skill")!;
    const read = toolRegistry.getById("read_skill_reference")!;
    for (const effectKind of [undefined, "read", "mutation", "external_side_effect"] as const) {
      skillRegistry.register({ ...skill, effectKind });
      const args = { skill_id: id, source: "body", ref: "SKILL.md", offset: 6000 };
      expect(resolveEffectKind(read, args)).toBe(resolveEffectKind(invoke, args));
      expect(resolveEffectKind(read, { skill_id: id, ref: "reference.md" })).toBe("read");
    }
    expect(resolveEffectKind(read, { skill_id: "missing", source: "body", ref: "SKILL.md" })).toBe("unknown");
  } finally {
    skillRegistry.unregister(id);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps same-run page deduplication through real dispatcher invocation clones without sharing role or run identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-dispatched-skill-pages-"));
  const id = "dispatched-page-fixture", dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: public\n---\n${"a".repeat(6000)}${"b".repeat(8000)}body tail`);
  fs.writeFileSync(path.join(dir, "references", "public.md"), `${"c".repeat(8000)}reference tail`);
  try {
    skillRegistry.register(scanSkills(root, "user")[0]); registerSkillTools();
    const read = toolRegistry.getById("read_skill_reference")!;
    const context = { userQuery: "synthetic", conversationId: "same-label", ownerSessionId: "same-owner-label", runId: "same-run-label", allowedSkillIds: new Set([id]) };
    let sequence = 0;
    const dispatch = async (toolContext: typeof context, args: Record<string, unknown>) => dispatchToolCall({
      id: `page-${++sequence}`, name: read.id, arguments: JSON.stringify(args),
    }, { state: { todoItems: [], uncertainEffects: [] }, tools: [read], toolContext });
    for (const args of [
      { skill_id: id, ref: "public.md" },
      { skill_id: id, source: "body", ref: "SKILL.md", offset: 6000 },
    ]) {
      const first = await dispatch(context, args); expect(first.outcome).toBe("success");
      expect((await dispatch(context, { ...args, runId: "model-cannot-reset-scope", ownerSessionId: "forged" })).output).toContain("已在本轮读过");
      // Equal or model-copied IDs confer no shared identity across Main-owned contexts.
      expect((await dispatch({ ...context }, args)).output).toBe(first.output);
      expect((await dispatch({ ...context, runId: "next-run" }, args)).output).toBe(first.output);
    }
    expect((await dispatch(context, { skill_id: id, source: "body", ref: "SKILL.md", offset: 14000 })).output).toBe("body tail");
    expect((await dispatch(context, { skill_id: id, ref: "public.md", offset: 8000 })).output).toBe("reference tail");
  } finally { skillRegistry.unregister(id); resetReadRefs(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("reads long body and references in bounded pages without widening run access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-skill-pages-"));
  const id = "public-page-fixture";
  const dir = path.join(root, id);
  const body = "A".repeat(6000) + "B".repeat(8000) + "body end";
  const reference = "C".repeat(8000) + "reference end";
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: public\n---\n${body}`);
  fs.writeFileSync(path.join(dir, "references", "large.md"), reference);
  try {
    skillRegistry.register(scanSkills(root, "user")[0]);
    registerSkillTools();
    resetReadRefs();
    const context = { userQuery: "public", allowedSkillIds: new Set([id]) };
    const invoke = toolRegistry.getById("invoke_skill")!;
    const read = toolRegistry.getById("read_skill_reference")!;
    const invoked = String(await invoke.execute({ skill_id: id }, context));
    expect(invoked).toContain("offset: 6000");
    expect(invoked).toContain(`Skill 本地目录（仅用于定位资源，不授权执行）：${dir}`);
    const args = { skill_id: id, source: "body", ref: "SKILL.md", offset: 6000 };
    const continuation = String(await read.execute(args, context));
    expect(continuation).toContain("B".repeat(8000));
    expect(continuation).toContain("offset: 14000");
    expect(await read.execute(args, context)).toContain("已在本轮读过");
    expect(await read.execute({ ...args, offset: 14000 }, context)).toBe("body end");
    expect(await read.execute({ skill_id: id, ref: "large.md" }, context)).toContain("offset: 8000");
    expect(await read.execute({ skill_id: id, ref: "large.md", offset: 8000 }, context)).toBe("reference end");
    expect(await read.execute({ ...args, ref: "../SKILL.md" }, context)).toContain("E_SKILL_READ_ARGUMENT");
    expect(await read.execute({ ...args, offset: -1 }, context)).toContain("E_SKILL_READ_ARGUMENT");
    expect(await read.execute({ ...args, offset: 0.5 }, context)).toContain("E_SKILL_READ_ARGUMENT");
    expect(await read.execute({ ...args, offset: body.length }, context)).toContain("E_SKILL_READ_ARGUMENT");
    expect(await read.execute(args, { ...context, allowedSkillIds: new Set() })).toContain("E_SKILL_UNAVAILABLE_IN_MODE");
  } finally {
    skillRegistry.unregister(id);
    resetReadRefs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("isolates reference and continuation deduplication between actual run contexts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-skill-run-pages-"));
  const id = "public-run-page-fixture";
  const directory = path.join(root, id);
  fs.mkdirSync(path.join(directory, "references"), { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${id}\ndescription: public\n---\n${"a".repeat(6000)}public continuation`);
  fs.writeFileSync(path.join(directory, "references", "public.md"), "public attachment");
  try {
    skillRegistry.register(scanSkills(root, "user")[0]);
    registerSkillTools();
    const read = toolRegistry.getById("read_skill_reference")!;
    const parent = { userQuery: "public", runId: "parent", allowedSkillIds: new Set([id]) };
    const child = { ...parent, runId: "child" };
    const next = { ...parent, runId: "next" };
    for (const args of [
      { skill_id: id, ref: "public.md" },
      { skill_id: id, source: "body", ref: "SKILL.md", offset: 6000 },
    ]) {
      const first = await read.execute(args, parent);
      expect(first).toContain("public");
      expect(await read.execute(args, parent)).toContain("已在本轮读过");
      expect(await read.execute(args, child)).toBe(first);
      expect(await read.execute(args, next)).toBe(first);
    }
  } finally {
    skillRegistry.unregister(id);
    resetReadRefs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
