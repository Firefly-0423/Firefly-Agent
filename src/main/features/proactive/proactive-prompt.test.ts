import { describe, it, expect } from "vitest";
import { buildProactiveMessages, parseProactiveDecision, type BuildProactiveMessagesInput } from "./proactive-prompt";

const anchor = Date.UTC(2026, 9, 5, 15, 42);
const systemInstructions = `[proactive_system]
你正在判断是否要主动向用户发起一次对话，而不是回答用户的新消息。
不要把历史聊天中的最后一句当作用户刚刚发来的消息；历史只用于理解用户最近的状态和话题。
如果没有自然且值得说的内容，请返回 silent。不要为了完成任务而强行寒暄。
不要提及系统检测、触发规则、评分、上下文、用户画像或内部状态。
消息应当简短自然，可以关心、分享、跟进或轻轻询问，但不要连续提出多个问题。
不要声称自己调用了工具、读取了屏幕或执行了任何外部动作。`;
const nightInstructions = `[night_system]
当前处于深夜，用户仍在使用电脑。
生成内容时可以更倾向于温柔关心用户的休息状态，适度提醒不要熬得太晚，但不要说教、催促或制造压力。
不要每次都提睡觉；如果上下文中有更自然、更重要的话题，可以先回应那个话题，再轻轻带到休息。
不要透露你检测到了用户的键盘、鼠标、屏幕或系统状态。
如果此刻没有值得主动说的话，请选择保持安静。`;
const followupInstructions = `[followup_system]
这是用户未回复情况下允许的最后一次主动机会。
本地系统已经确认用户在离开后再次返回，但你仍应判断这次新的返回是否值得打扰用户。
不要责怪、催促、卖惨或表现出被冷落，也不要机械地重复"在吗"。
没有充分理由时必须返回 silent。`;
const joinBlocks = (...blocks: string[]) => blocks.join("\n\n---\n\n");
const emptyHistories = ["[最近使用的普通聊天会话]\n（暂无）", "[主动聊天专用会话]\n（暂无）"];
function compose(changes: Partial<BuildProactiveMessagesInput> = {}) {
  return buildProactiveMessages({ localNow: new Date(anchor), sceneId: "evening_checkin",
    basePersona: "  Considerate companion  ", timezone: "UTC", unansweredCount: 0,
    idleSec: 3, proactiveHistory: [], ordinaryHistory: [], ...changes });
}

describe("model decision decoding", () => {
  it("trims a send decision and disregards text when silence is chosen", () => {
    expect(parseProactiveDecision('  {"text":"  Shall we pause?  ","decision":"send"}  '))
      .toEqual({ text: "Shall we pause?", kind: "send" });
    expect(parseProactiveDecision('{"text":"irrelevant content","decision":"silent"}')).toEqual({ kind: "silent" });
  });

  it.each([
    ["preface: {\"decision\":\"silent\"}", "invalid_json"],
    ["```json\n{}\n```", "invalid_json"], ["null", "invalid_shape"], ["[]", "invalid_shape"],
    ['"message"', "invalid_shape"], ['{"decision":"wait"}', "invalid_decision"],
    ['{"decision":"send","text":"  "}', "empty_text"], ['{"decision":"send","text":27}', "empty_text"],
  ])("classifies rejected output %s", (raw, reason) => {
    expect(parseProactiveDecision(raw)).toEqual({ kind: "invalid", reason });
  });

  it("accepts 500 trimmed characters but rejects the next character", () => {
    const text = "z".repeat(500);
    expect(parseProactiveDecision(JSON.stringify({ text: ` ${text} `, decision: "send" })))
      .toEqual({ kind: "send", text });
    expect(parseProactiveDecision(JSON.stringify({ text: `${text}z`, decision: "send" })))
      .toEqual({ kind: "invalid", reason: "text_too_long" });
  });
});

describe("complete model-visible prompt", () => {
  it("returns two roles in order with exact instructions and strict JSON alternatives", () => {
    const messages = compose();
    expect(messages).toEqual([
      { role: "system", content: joinBlocks("Considerate companion", systemInstructions, ...emptyHistories) },
      { role: "user", content: `[本次主动聊天候选]
电脑本地时间：2026-10-05 15:42
候选场景：evening_checkin
连续未回复次数：0

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"decision":"send","text":"要发送的一条自然消息"}
或
{"decision":"silent","text":""}` },
    ]);
    const visible = messages.map((entry) => entry.content).join("\n");
    expect(visible).not.toContain("Tool Calling");
    expect(visible).not.toContain("工具目录");
  });

  it("keeps the last sixteen usable rows of each history in their original order", () => {
    const rows = (label: string, length: number) => Array.from({ length }, (_, n) => ({
      at: anchor, role: n % 2 === 0 ? "user" as const : "model" as const, content: ` ${label}:${n} `,
    }));
    const ordinaryHistory = rows("daily-entry", 23);
    const proactiveHistory = rows("outreach-entry", 21);
    const messages = compose({ ordinaryHistory, proactiveHistory,
      userProfile: "  Enjoys astronomy  ", relevantMemory: "  Telescope arrived  " });
    const expectedRows = (label: string, first: number) => Array.from({ length: 16 }, (_, n) => {
      const ordinal = first + n;
      return `[2026-10-05 15:42] ${ordinal % 2 ? "assistant" : "user"}: ${label}:${ordinal}`;
    }).join("\n");
    expect(messages[0].content).toEqual(joinBlocks("Considerate companion", systemInstructions,
      "[用户画像]\nEnjoys astronomy", "[相关长期记忆]\nTelescope arrived",
      `[最近使用的普通聊天会话]\n${expectedRows("daily-entry", 7)}`,
      `[主动聊天专用会话]\n${expectedRows("outreach-entry", 5)}`));
    expect(String(messages[0].content)).not.toContain("daily-entry:6\n");
    expect(String(messages[0].content)).not.toContain("outreach-entry:4\n");
  });

  it("omits blank profile and memory and filters blank history rows", () => {
    expect(compose({ userProfile: " \n", relevantMemory: "\t", ordinaryHistory: [{ at: anchor, role: "user", content: " " }] })[0].content)
      .toEqual(joinBlocks("Considerate companion", systemInstructions, ...emptyHistories));
  });

  it("appends the final-followup instructions only for one unanswered message", () => {
    expect(compose({ unansweredCount: 1, sceneId: "back_from_away" })[0].content)
      .toEqual(joinBlocks("Considerate companion", systemInstructions, ...emptyHistories, followupInstructions));
    expect(String(compose({ unansweredCount: 2 })[0].content)).not.toContain("[followup_system]");
  });

  it.each([
    ["Asia/Taipei", "2026-10-05 23:42", true],
    ["UTC", "2026-10-05 15:42", false],
    ["America/Los_Angeles", "2026-10-05 08:42", false],
  ] as const)("uses %s for both history and candidate timestamps", (timezone, stamp, night) => {
    const messages = compose({ timezone, ordinaryHistory: [{ role: "user", at: anchor, content: "Observatory plans" }] });
    expect(String(messages[1].content)).toContain(`电脑本地时间：${stamp}`);
    expect(String(messages[0].content)).toContain(`[${stamp}] user: Observatory plans`);
    expect(String(messages[0].content).includes("[night_system]")).toBe(night);
    if (night) expect(String(messages[0].content)).toContain(nightInstructions);
  });

  it.each([
    [21, 59, 30, false], [22, 0, 30, true], [23, 0, 20, true],
    [7, 0, 30, true], [7, 59, 59, true], [8, 0, 0, false], [9, 0, 0, false], [23, 30, 60, false],
  ] as const)("decides night context at %i:%i with %i idle seconds", (hour, minute, idleSec, night) => {
    const localNow = new Date(Date.UTC(2026, 9, 6, hour - 8, minute));
    const actual = compose({ timezone: "Asia/Shanghai", localNow, idleSec })[0].content;
    expect(actual).toEqual(joinBlocks("Considerate companion", systemInstructions, ...emptyHistories, ...(night ? [nightInstructions] : [])));
  });

  it("falls back gracefully when a timezone cannot be resolved", () => {
    const messages = compose({ timezone: "Invalid/Observatory" });
    expect(String(messages[1].content)).toContain("电脑本地时间：");
    expect(String(messages[1].content)).toContain("候选场景：evening_checkin");
  });
});
