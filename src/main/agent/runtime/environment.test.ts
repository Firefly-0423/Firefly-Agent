import { describe, it, expect } from "vitest";
import { buildEnvironmentContext as environment } from "./environment";

describe("Model-visible desktop environment", () => {
  it("uses the preferred address, saved nickname, and default address in that priority", () => {
    const preferred = environment(undefined, { callPreference: "同行者", gender: "male" });
    expect(preferred).toContain("重要提问或确认时，可以自然使用一次「同行者」");
    expect(preferred).toContain("不得使用女性指向称呼");
    const nickname = environment(undefined, { nickname: "阿岚", callPreference: "  " });
    expect(nickname).toContain("称呼使用：在重要提问或确认时，可以自然使用一次「阿岚」");
    expect(nickname).not.toContain("称呼偏好：  ");
    expect(environment(undefined, { nickname: "", callPreference: "" })).toContain("称呼使用：在重要提问或确认时，可以自然使用一次「开拓者」");
  });

  it("separates a saved city from the timezone's limited meaning", () => {
    const context = environment(undefined, { timezone: "Asia/Shanghai", defaultCity: "上海" });
    expect(context).toContain("用户时区仅用于时间计算");
    expect(context).toContain("不得根据时区推断用户所在城市");
    expect(context).toMatch(/默认城市：上海[\s\S]*用户时区仅用于时间计算/);
  });

  it.each(["Asia/Tokyo", "Asia/Shanghai", "America/New_York"])("formats unambiguous 24-hour time for %s", (timezone) => {
    const context = environment(undefined, { timezone });
    const match = context.match(/- 当前时间：(\d{4}-\d{2}-\d{2} [周星期]\S? \d{2}:\d{2})（时区 ([\w/]+)）/);
    expect(match).not.toBeNull();
    expect(match?.[2]).toEqual(timezone);
    expect(context).toMatch(/- 当前时间：(\d{4}-\d{2}-\d{2} [周星期]\S? \d{2}:\d{2}（时区 [\w/]+)/);
    expect(context).not.toMatch(/(上午|下午|AM|PM)/);
    expect(context).toContain("（时区 " + timezone + "）");
    if (timezone === "Asia/Tokyo") expect(context).not.toMatch(/时区 Asia\/Shanghai/);
  });

  it.each([undefined, "", "invalid/region", "Foo/Bar"])("falls back safely for missing or invalid timezone %s", (timezone) => {
    expect(() => environment(undefined, timezone === undefined ? undefined : { timezone })).not.toThrow();
    expect(environment(undefined, timezone === undefined ? undefined : { timezone })).toMatch(/时区 Asia\/Shanghai/);
  });

  it("shows generic permission rules without advertising tool IDs or permission buckets", () => {
    const context = environment();
    for (const removed of ["可直接调用的工具", "需先弹审批的工具", "被拒绝的工具", "record_expense", "search_text", "read_file", "apply_patch", "str_replace", "write_file", "run_shell"]) expect(context).not.toContain(removed);
    expect(context).toMatch(/- 文件权限档位：.+/);
    expect(context).toContain("工具能否调用以本轮提供的工具清单为准");
    expect(context).toContain("高风险操作可能触发审批确认");
  });

  it("reports the caller's resolved image capability and defaults to no vision", () => {
    expect(environment({ provider: "ChatGPT（OpenAI）", model: "gpt-4o", multimodal: true })).toContain("当前模型是否支持查看图片：支持（可调 read_image 看图）");
    expect(environment({ provider: "GLM（智谱）", model: "glm-5.2", multimodal: false })).toContain("当前模型是否支持查看图片：不支持");
    expect(environment()).toContain("当前模型是否支持查看图片：不支持");
  });
});
