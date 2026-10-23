import { describe, expect, it } from "vitest";
import { normalizeChatMessagesWithTime, buildConversationTimeContext, stripLeakedChatTimeContext, resolveChatContextTimezone } from "./chat-time-context";
const stamp = Date.UTC(2027, 0, 9, 6, 0);
describe("timestamp normalization", () => {
    it("cleans content, aliases model roles, and discards invalid dates and empty messages", () => {
        expect(normalizeChatMessagesWithTime([
            { role: "user", content: "  question  ", at: stamp },
            { role: "model", content: " response ", at: "invalid" },
            { role: "system", content: "<think>private</think> instruction ", at: NaN },
            { role: "user", content: "\t", at: stamp + 1 }, null, { content: 3 },
        ])).toEqual([{ role: "user", content: "question", at: stamp }, { role: "assistant", content: "response" }, { role: "system", content: "instruction" }]);
    });
    it("keeps the most recent twenty-four normalized entries in order", () => {
        const history = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? "model" : "user", content: `turn-${i}`, at: stamp + i }));
        const cleaned = normalizeChatMessagesWithTime(history);
        expect(cleaned).toHaveLength(24);
        expect(cleaned).toEqual(history.slice(1).map(item => ({ ...item, role: item.role === "model" ? "assistant" : "user" })));
    });
    it("prefers a valid profile zone, then an explicit fallback, then Shanghai", () => {
        expect(resolveChatContextTimezone("Europe/Paris", "UTC")).toEqual("Europe/Paris");
        for (const invalid of [undefined, "", "not/a-zone"]) {
            expect(resolveChatContextTimezone(invalid)).toEqual("Asia/Shanghai");
            expect(resolveChatContextTimezone(invalid, "Europe/London")).toEqual("Europe/London");
        }
    });
});
describe("model-visible conversation timing", () => {
    it("prefixes only dated user turns with the exact private note", () => {
        const result = buildConversationTimeContext([
            { role: "user", content: "Check the agenda", at: stamp },
            { role: "assistant", content: "I will", at: stamp + 120000 }, { role: "assistant", content: "Undated" },
        ], "Asia/Taipei");
        expect(result.messages.map(item => item.content)).toEqual([
            "<internal_context>用户发送这条消息的时间：2027-01-09 14:00；用户时区：Asia/Taipei。</internal_context>\n\nCheck the agenda", "I will", "Undated",
        ]);
        expect(result.timeContext).toContain("## Internal Context Policy");
        expect(result.timeContext).toContain("must never become part of the user-visible response");
    });
    it("uses the most recent chat pair for one neutral gap note", () => {
        const result = buildConversationTimeContext([
            { role: "user", content: "older", at: stamp - 86400000 },
            { role: "user", content: "earlier", at: stamp - 50000000 },
            { role: "assistant", content: "previous", at: stamp },
            { role: "user", content: "returning", at: stamp + (14 * 60 + 58) * 60000 },
        ], "Asia/Taipei");
        expect(result.timeContext).toContain([
            "[对话时间信息]", "当前时间：2027-01-10 04:58, Asia/Taipei",
            "距离上一条有效聊天消息：约 14 小时 58 分钟",
            "仅用于理解对话连续性；除非与当前语境有关，否则不要主动提及时间间隔，也不要复述本段内容。",
        ].join("\n"));
        expect(result.timeContext.match(/距离上一条有效聊天消息/g)).toHaveLength(1);
    });
    it.each([3599999, 3600000])("applies the hour threshold at %i milliseconds", interval => {
        const { timeContext } = buildConversationTimeContext([{ role: "assistant", content: "a", at: stamp }, { role: "user", content: "b", at: stamp + interval }], "Asia/Taipei");
        if (interval < 3600000)
            expect(timeContext).not.toContain("距离上一条有效聊天消息");
        else
            expect(timeContext).toContain("距离上一条有效聊天消息：约 1 小时");
    });
    it("cannot calculate a gap without both timestamps", () => {
        expect(buildConversationTimeContext([{ role: "assistant", content: "previous" }, { role: "user", content: "current", at: stamp }], "Asia/Taipei").timeContext).toContain("## Internal Context Policy");
        expect(buildConversationTimeContext([{ role: "assistant", content: "previous", at: stamp }, { role: "user", content: "current" }], "Asia/Taipei").timeContext).toEqual("");
    });
    it("removes leaked leading metadata while retaining inline references", () => {
        const label = "[2027-01-09 14:00, Asia/Shanghai]";
        expect(stripLeakedChatTimeContext(label + "\nVisible response")).toEqual("Visible response");
        const inline = `A time example ${label} in a sentence`;
        expect(stripLeakedChatTimeContext(inline)).toEqual(inline);
    });
});
