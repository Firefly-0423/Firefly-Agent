import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaskCharacterLeasePool, buildTaskCompanionPrompt, getTaskCompanionNames } from "./task-character-pool";
import { TASK_CHARACTERS } from "../../shared/task-characters";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";

describe("TaskCharacterLeasePool", () => {
  it("exposes the twelve supplied display characters without assigning duties", () => {
    expect(getTaskCompanionNames()).toHaveLength(12);
    expect(getTaskCompanionNames()).toContain("艾利欧");
    expect(getTaskCompanionNames()).toContain("卡芙卡");
    expect(getTaskCompanionNames()).not.toContain("卡夫卡");
    expect(getTaskCompanionNames()).toContain("知更鸟");
    expect(buildTaskCompanionPrompt()).toContain("delegate_agent");
    expect(buildTaskCompanionPrompt()).not.toMatch(/subagent_type|companion_id/);
    expect(buildTaskCompanionPrompt()).not.toContain("黄金裔");
  });

  it("lists all twelve specialists in Work and tells the main agent to start with the primary one", () => {
    const prompt = buildTaskCompanionPrompt("work");
    for (const agent of SPECIALIST_AGENTS) expect(prompt, agent.id).toContain(`${agent.id}（${agent.nickname}）`);
    expect(prompt).toContain("先判断任务主要属于哪个领域，只先委托最主责的那一位");
    expect(prompt).toContain("再继续委托其他角色");
    expect(prompt).toContain("不要一次性委托全部角色");
    // Code keeps the roles whose tools exist there; documents-data stays a Work-only role.
    expect(buildTaskCompanionPrompt("code")).not.toContain("documents-data（知更鸟）");
    expect(SPECIALIST_AGENTS.filter(agent => agent.supportedModes.includes("code"))).toHaveLength(11);
  });

  it("has a PNG asset for every displayed task character", () => {
    expect(TASK_CHARACTERS.find((character) => character.nickname === "卡芙卡")?.assetFileName).toBe("卡芙卡.png");
    for (const character of TASK_CHARACTERS) {
      const path = fileURLToPath(new URL(`../../renderer/assets/task-portraits/${character.assetFileName}`, import.meta.url));
      expect(existsSync(path), character.assetFileName).toBe(true);
      expect(readFileSync(path).subarray(0, 8).toString("hex"), character.assetFileName).toBe("89504e470d0a1a0a");
    }
  });

  it("leases an exact supplied character and releases it after use", () => {
    const pool = new TaskCharacterLeasePool();
    const lease = pool.acquire("chat-a", "艾利欧");
    expect(lease).toMatchObject({ nickname: "艾利欧", assetFileName: "艾利欧.png" });
    expect(() => pool.acquire("chat-a", "艾利欧")).toThrow("TASK_COMPANION_BUSY");
    lease.release();
    expect(pool.acquire("chat-a", "艾利欧").assetFileName).toBe("艾利欧.png");
    expect(() => pool.acquire("chat-a", "风堇")).toThrow("TASK_COMPANION_UNKNOWN");
  });
});
