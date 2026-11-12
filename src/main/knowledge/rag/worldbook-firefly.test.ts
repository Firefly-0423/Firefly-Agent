import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorldbookManager, type WorldbookEntry } from "./worldbook";
import { INJECTION_PREAMBLE } from "./worldbook-constants";

const worldbookDirectory = path.join(process.cwd(), "prompts", "worldbook");

describe("Firefly worldbook loading", () => {
  it("loads the migrated relationship entry through the real directory parser and triggers it", async () => {
    const manager = new WorldbookManager(worldbookDirectory, { debug: false });
    await manager.loadFromDirectory();

    expect(manager.getEntries().some((entry) => entry.id === "wb_firefly-relations_卡芙卡与流萤")).toBe(true);
    expect(manager.getPermanentEntries()).toEqual([]);
    manager.updateActivation("卡芙卡", "", 1);

    const active = manager.getActiveEntries().join("\n");
    expect(active).toContain("卡芙卡找到流萤");
    expect(active).not.toContain("银狼是星核猎手同伴");
  });

  it("does not inject character lore for unrelated work or treat the current user as the original Trailblazer", async () => {
    const manager = new WorldbookManager(worldbookDirectory, { debug: false });
    await manager.loadFromDirectory();

    manager.updateActivation("请检查这段 TypeScript 代码", "", 1);

    expect(manager.getActiveEntries()).toEqual([]);
    expect(manager.getCascadeEntries()).toEqual([]);
    expect(INJECTION_PREAMBLE).toContain("原作中的开拓者与当前用户的共同经历必须区分");
  });

  it("loads Penacony knowledge only for its subject and keeps original history separate", async () => {
    const manager = new WorldbookManager(worldbookDirectory, { debug: false });
    await manager.loadFromDirectory();

    manager.updateActivation("匹诺康尼是什么地方？", "", 1);

    const active = manager.getActiveEntries().join("\n");
    expect(active).toContain("匹诺康尼是流萤原作经历中的梦境舞台");
    expect(active).toContain("不能自动当作流萤与当前用户的共同经历");
    expect(active).not.toContain("帕姆是列车长");
  });

  it("loads the origin-story entries only for their subjects and keeps them out of the current user's history", async () => {
    const manager = new WorldbookManager(worldbookDirectory, { debug: false });
    await manager.loadFromDirectory();

    manager.updateActivation("你是在培养仓里醒来的吗？", "", 1);
    const origin = manager.getActiveEntries().join("\n");
    expect(origin).toContain("周围的人在重复同一句口号");
    expect(origin).toContain("不要求用户同情或表态");
    expect(origin).not.toContain("同袍成片倒下");

    manager.updateActivation("你的名字的由来是什么？", "", 2);
    const name = manager.getActiveEntries().join("\n");
    expect(name).toContain("不用作每句话的修饰");

    manager.updateActivation("聊聊你的同袍吧", "", 3);
    const comrades = manager.getActiveEntries().join("\n");
    expect(comrades).toContain("不构成与当前用户的共同记忆");
  });

  it("injects the daily-life entry only for its topics and marks it as original-work detail", async () => {
    const manager = new WorldbookManager(worldbookDirectory, { debug: false });
    await manager.loadFromDirectory();

    manager.updateActivation("最近老是失眠", "", 1);
    const active = manager.getActiveEntries().join("\n");
    expect(active).toContain("夜里常去屋顶看星海");
    expect(active).toContain("也不要把它们当成与当前用户一起经历过的事");

    const unrelated = new WorldbookManager(worldbookDirectory, { debug: false });
    await unrelated.loadFromDirectory();
    unrelated.updateActivation("帮我重构这个函数", "", 1);
    expect(unrelated.getActiveEntries()).toEqual([]);
  });

  it("does not inject an already active entry again through a linked trigger", () => {
    const manager = new WorldbookManager(worldbookDirectory, { debug: false });
    const entry = (id: string, keyword: string, linkTriggers: string[] = []): WorldbookEntry => ({
      id,
      keywords: [keyword],
      content: id,
      priority: 100,
      permanent: false,
      enabled: true,
      intrinsicValue: 60,
      linkTriggers,
    });
    manager.loadFromEntries([entry("source", "源", ["目标"]), entry("target", "目标")]);

    manager.updateActivation("目标", "", 1);
    manager.updateActivation("源", "", 2);

    expect(manager.getActiveEntries().join("\n")).toContain("target");
    expect(manager.getCascadeEntries().map((item) => item.id)).not.toContain("target");
  });
});
