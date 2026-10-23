import { afterEach, beforeEach, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelationshipLogStore } from "./relationship-log";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ff-relationship-contract-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it("persists a clear interaction boundary with a matching daily summary", async () => {
  const filename = join(directory, "journal.json");
  await new RelationshipLogStore(filename).recordTurn({ channel: "desktop", userText: "别再问确认了，请安静处理",
    assistantText: "我会按你的偏好处理。", fireflyFeeling: "认真" });
  const saved = JSON.parse(readFileSync(filename, "utf8"));
  expect(saved.entries).toHaveLength(1);
  expect(saved.entries[0].userMood).toBe("明确边界");
  expect(saved.entries[0].relationshipSignal).toContain("低打扰");
  expect(saved.entries[0].nextCareCue).toContain("不要弹确认");
  expect(saved.dailySummaries[0].summary).toContain("明确边界");
});
it("exposes recent fatigue and response cues to the next model request", async () => {
  const journal = new RelationshipLogStore(join(directory, "journal.json"));
  await journal.recordTurn({ channel: "desktop", userText: "有点疲惫，想歇一会儿", assistantText: "陪你坐一会儿。",
    fireflyFeeling: "关心" });
  const context = await journal.buildContext();
  for (const phrase of ["【近期关系线索】", "用户最近状态", "疲惫", "下次回应提示"]) expect(context).toContain(phrase);
});
it("keeps ordinary negation out of boundary classification", async () => {
  const filename = join(directory, "journal.json"), journal = new RelationshipLogStore(filename);
  for (const userText of ["不想喝咖啡，换杯茶", "想看点别的书", "先不管构建，看看说明"]) {
    await journal.recordTurn({ channel: "desktop", userText, assistantText: "知道了", fireflyFeeling: "自然" });
  }
  const saved = JSON.parse(readFileSync(filename, "utf8"));
  expect(saved.entries.map((entry: { userMood: string }) => entry.userMood)).toEqual(["未知", "未知", "未知"]);
});
