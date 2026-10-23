import { expect, test } from "vitest";
import { resolveRevisableLastTurn } from "./last-turn-actions";

type Entry = Parameters<typeof resolveRevisableLastTurn>[0][number];
const question: Entry = { id: "question-final", role: "user" };
const answer: Entry = { id: "reply-final", role: "assistant" };
const history: Entry[] = [{ id: "question-earlier", role: "user" }, { id: "reply-earlier", role: "model" }];

test.each(["assistant", "model"] as const)("selects the last completed %s pair", (role) => {
  expect(resolveRevisableLastTurn([...history, question, { ...answer, role }], "chat"))
    .toStrictEqual({ assistantMessageId: "reply-final", userMessageId: "question-final" });
});

test.each(["work", "code"] as const)("disallows revision in %s sessions", (mode) => {
  expect(resolveRevisableLastTurn([question, answer], mode)).toBeNull();
});

test.each(["loading", "streaming", "reasoningStreaming"] as const)("waits for %s to finish", (flag) => {
  expect(resolveRevisableLastTurn([question, { ...answer, [flag]: true }], "chat")).toBeNull();
});

test.each(([
  [], [question], [...history, question], [answer, answer], [question, { ...answer, role: "system" }],
  [{ ...question, channelSource: { channel: "wechat" } }, answer],
  [question, { ...answer, channelSource: { channel: "qq" } }],
] satisfies Entry[][]).map((messages) => ({ messages })))("rejects incomplete, mismatched and mirrored pairs: $messages", ({ messages }) => {
  expect(resolveRevisableLastTurn(messages, "chat")).toBeNull();
});
