// @vitest-environment jsdom
import * as React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessageChannelSource } from "../../../../../shared/chat-types";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null }, CodeHighlighter: () => null,
  ThoughtChain: ({ items }: { items: { key: string; title: React.ReactNode; description?: React.ReactNode }[] }) =>
    items.map((item) => React.createElement("div", { key: item.key, "data-chain-item": item.key }, item.title, " ", item.description)),
  Think: ({ icon, title, children }: { icon: React.ReactNode; title: React.ReactNode; children: React.ReactNode }) =>
    React.createElement("section", null, icon, title, children),
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
import { assembleMessageItems, createMessageItems, formatChannelSourceLabel, MarkdownContent, resolveChannelConversationLabel,
  RunActivityDetail, type ChatMessageItem, type EnabledSticker } from "./ChatMessageList";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => { vi.unstubAllGlobals(); document.head.replaceChildren(); document.body.replaceChildren(); });
const reply = (patch: Partial<ChatMessageItem> = {}): ChatMessageItem =>
  ({ id: "reply-review", role: "assistant", content: "Review complete", ...patch });
const items = (message: ChatMessageItem) => createMessageItems([message], []);
const roles = (message: ChatMessageItem) => items(message).map(item => item.role);
const activity = { startedAt: 100, completedAt: 200, reasoningMs: 0 };
const narration = [{ id: "inspection-note", content: "Inspecting the guide", afterToolCount: 0 }];
const draw = (props: Partial<React.ComponentProps<typeof RunActivityDetail>> = {}) =>
  renderToStaticMarkup(React.createElement(RunActivityDetail, { tools: [], reasoningBlocks: [], processMessages: [], ...props }));
function style(selector: string) {
  const tag = document.createElement("style");
  tag.textContent = readFileSync("src/renderer/react/features/chat/components/ChatMessageList.css", "utf8");
  document.head.append(tag);
  const rule = Array.from(tag.sheet!.cssRules).find(rule => (rule as CSSStyleRule).selectorText === selector) as CSSStyleRule | undefined;
  expect(rule).toBeDefined();
  return rule!.style;
}

test("removes transport sticker markers while retaining the stored message and retired notice", () => {
  const stored: ChatMessageItem = { id: "archived-greeting", role: "user", content: "Greetings [sticker:calm]" };
  const [bubble] = items(stored);
  expect(bubble.content).toBe("Greetings");
  expect(bubble.extraInfo).toMatchObject({ stickerUnavailable: "表情包已下架" });
  expect(stored.content).toBe("Greetings [sticker:calm]");
  expect(extractMessageStickerId("[sticker:calm]")).toBe("calm");
  expect(stripMessageStickerMarkers("[sticker:calm]")).toBe("");
  expect(stripMessageStickerMarkers("Greetings [sticker:calm]")).toBe("Greetings");
});

test.each(["pending", "unknown", "interrupted"] as const)("keeps %s settlement text diagnostic without a formal assistant role", (state) => {
  const bubbles = items(reply({ content: "Cached response", responseStarted: true, ttsCacheKey: "unsafe-speech",
    sSettlement: { state, runId: "review-run", assistantEntryId: "canonical-entry", originalText: "Uncommitted response" } }));
  expect(bubbles.some(item => item.role === "assistant")).toBe(false);
  expect(bubbles.find(item => item.role === "sAudit")).toMatchObject({ content: "Uncommitted response", extraInfo: { state } });
});

test("adds the authoritative file read report separately from the model claim", () => {
  const message = reply({ content: "All pages were read", responseStarted: true, workReadReport: {
    status: "partial", files: [{ name: "guide.txt", status: "partial", coveredLines: 3, requiredLines: 6, totalLines: 6 }],
  } });
  const bubbles = items(message);
  expect(bubbles.map(item => item.role)).toStrictEqual(["assistant", "system"]);
  expect(String(bubbles[1].content)).toContain("3/6");
  expect(message.content).toBe("All pages were read");
});

test("uses transient display text without modifying persisted content", () => {
  const message = reply({ content: "", transientText: "Draft preview", responseStarted: true, streaming: true });
  expect(items(message)[0]).toMatchObject({ role: "assistant", content: "Draft preview", extraInfo: { streaming: true } });
  expect(message.content).toBe("");
});

test.each([true, false])("renders Markdown for streaming=%s without live-tail decorations", (streaming) => {
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: "Visible response", streaming }));
  // While streaming, each character is wrapped for its fade-in, so compare the visible text.
  expect(html.replace(/<[^>]+>/g, "")).toContain("Visible response");
  expect(html.includes("data-sd-animate")).toBe(streaming);
  expect(html).toContain("ff-streamdown-message");
  for (const forbidden of ["ff-live-answer", "流萤正在生成…"]) expect(html).not.toContain(forbidden);
});

test("keeps heading spacing and underline independent from following paragraphs", () => {
  const first = style(".ff-message--assistant .ff-message-markdown h1");
  expect(first.getPropertyValue("padding-bottom")).toBe("8px");
  expect(first.getPropertyValue("border-bottom")).toMatch(/^1px solid/);
  expect(first.getPropertyValue("margin")).toBe("26px 0px 16px");
  expect(style(".ff-message--assistant .ff-message-markdown h2").getPropertyValue("margin")).toBe("24px 0px 10px");
  expect(style(".ff-message--assistant .ff-message-markdown h3").getPropertyValue("margin")).toBe("20px 0px 8px");
  const css = readFileSync("src/renderer/react/features/chat/components/ChatMessageList.css", "utf8");
  expect(css).not.toContain("ff-live-answer");
  expect(css).not.toContain("ff-live-answer-breathe");
});

test("shows activity only for a live run or a terminal run containing process content", () => {
  expect(roles(reply({ content: "", runActivity: { ...activity, keepExpanded: true }, responseStarted: false, processMessages: narration })))
    .toStrictEqual(["activity"]);
  expect(roles(reply({ runActivity: activity, responseStarted: true }))).toStrictEqual(["assistant"]);
  expect(roles(reply({ content: "", runActivity: { startedAt: 100, reasoningMs: 0 } }))).toStrictEqual(["activity"]);
  expect(roles(reply({ runActivity: activity, responseStarted: true, processMessages: narration }))).toStrictEqual(["activity", "assistant"]);
});

test("retains exactly one visible avatar for activity replies and normal avatars for plain replies", () => {
  const bubbles = items(reply({ runActivity: activity, processMessages: narration }));
  expect(bubbles.find(item => item.role === "activity")?.avatar).toBeTruthy();
  expect(bubbles.find(item => item.role === "assistant")?.rootClassName).toContain("ff-message--assistant-run");
  expect(style(".ff-message--assistant-run .ant-bubble-avatar").getPropertyValue("visibility")).toBe("hidden");
  const css = readFileSync("src/renderer/react/features/chat/components/ChatMessageList.css", "utf8");
  expect(css).not.toMatch(/\.ff-message--activity \.ant-bubble-avatar \{\s*display: none/);
  expect(items(reply({ runActivity: activity }))[0].rootClassName ?? "").not.toContain("ff-message--assistant-run");
});

test("attaches review to a settled answer, or creates an aligned standalone review without formal text", () => {
  const answered = items(reply({ streaming: false, runId: "review-run" }));
  expect(answered.map(item => item.role)).toStrictEqual(["assistant"]);
  expect(answered[0].extraInfo?.reviewRunId).toBe("review-run");
  const noAnswer = items(reply({ content: "", streaming: false, runId: "review-run",
    sSettlement: { state: "unknown", runId: "review-run", assistantEntryId: "entry-review", originalText: "Unsettled" } }));
  const review = noAnswer.find(item => item.role === "review");
  expect(review?.extraInfo?.runId).toBe("review-run");
  expect(review?.avatar).toBeTruthy();
  expect(review?.rootClassName).toContain("ff-message--review-run");
  const avatar = style(".ff-message--review-run .ant-bubble-avatar");
  expect(avatar.getPropertyValue("display")).toBe("block");
  expect(avatar.getPropertyValue("visibility")).toBe("hidden");
  expect(style(".ff-message--review-run .ant-bubble-body").getPropertyValue("width"))
    .toBe("calc(100% - 38px - var(--ff-avatar-gap))");
  expect(roles(reply({ streaming: true, runId: "stream-run" }))).not.toContain("review");
  expect(roles(reply({ streaming: false }))).not.toContain("review");
});

test("adds only group sender names to incoming bubbles and preserves source metadata", () => {
  const source: ChatMessageChannelSource = { channel: "wechat", chatType: "group", senderName: "Guide author" };
  expect(formatChannelSourceLabel(source, "incoming")).toBe("Guide author");
  for (const candidate of [{ ...source, chatType: "private" }, { channel: "qq", senderName: "Legacy author" }, { channel: "unknown" }]) {
    expect(formatChannelSourceLabel(candidate as ChatMessageChannelSource, "incoming")).toBe("");
  }
  expect(formatChannelSourceLabel({ channel: "qq" }, "outgoing")).toBe("");
  const [bubble] = items({ id: "channel-question", role: "user", content: "Review tomorrow", channelSource: source });
  expect(bubble.content).toBe("Review tomorrow");
  expect(bubble.extraInfo?.channelSource).toStrictEqual(source);
  expect(resolveChannelConversationLabel([{ channelSource: source }, { channelSource: source }])).toBe("微信 · 同一对话");
  expect(resolveChannelConversationLabel([{ channelSource: source }, { channelSource: { channel: "qq" } }])).toBe("微信、QQ · 同一对话");
  expect(resolveChannelConversationLabel([{}])).toBeNull();
});

const rounds = [
  { id: "inspection", status: "completed" as const, startedAt: 100, completedAt: 200 },
  { id: "verification", status: "running" as const, startedAt: 300 },
];
test("keeps the live event timeline flat and in sequence across model rounds", () => {
  const html = draw({ live: true, agentRounds: rounds,
    reasoningBlocks: [{ id: "plan", roundId: "inspection", content: "Plan the inspection", seq: 0 },
      { id: "evaluate", roundId: "verification", content: "Evaluate the result", seq: 3 }],
    processMessages: [{ id: "announce", roundId: "inspection", content: "Inspect the workspace", seq: 1 }],
    tools: [{ id: "scan", roundId: "inspection", name: "list_dir", status: "success", seq: 2 }],
  });
  expect(html).not.toContain("ff-agent-round");
  for (const text of ["Plan the inspection", "Inspect the workspace", "Evaluate the result"]) expect(html).toContain(text);
  expect(html.indexOf("Plan the inspection")).toBeLessThan(html.indexOf("Inspect the workspace"));
  expect(html.indexOf("Inspect the workspace")).toBeLessThan(html.indexOf("Evaluate the result"));
});

test("folds a live stretch of reads and searches into one line of counts and keeps a command on its own", () => {
  const html = draw({ live: true, agentRounds: [rounds[1]], reasoningBlocks: [], processMessages: [],
    tools: [{ id: "r1", roundId: "verification", name: "read_file", status: "success", seq: 1, argsText: JSON.stringify({ path: "src/main.rs" }) },
      { id: "s1", roundId: "verification", name: "search_code", status: "success", seq: 2 },
      { id: "r2", roundId: "verification", name: "read_file", status: "success", seq: 3, argsText: JSON.stringify({ path: "notes/todo.md" }) },
      { id: "x1", roundId: "verification", name: "run_shell", status: "running", seq: 4, argsText: JSON.stringify({ command: "cargo test" }) }],
  });
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toContain("读取 2 个文件 · 搜索 1 次");
  expect(text).toContain("main.rs, todo.md");
  expect(text).toContain("cargo test");
  expect(html.match(/ff-tool-executions"/g)).toHaveLength(2);
});
test("settled round groups retain narration, live reasoning and truthful titles", () => {
  const html = draw({ agentRounds: rounds,
    reasoningBlocks: [{ id: "cached-thought", roundId: "verification", content: "Inspection understood", streaming: false },
      { id: "live-thought", roundId: "verification", content: "Checking the result", streaming: true }],
    processMessages: [{ id: "intro", roundId: "inspection", content: "Inspecting directories" },
      { id: "followup", roundId: "verification", content: "Verifying cancellation" }],
    tools: [{ id: "scan", roundId: "inspection", name: "list_dir", status: "success" },
      { id: "read", roundId: "verification", name: "read_file", status: "running" }],
  });
  expect(html.match(/class="ff-agent-round(?: is-(?:running|complete))?"/g)).toHaveLength(2);
  for (const oldArt of ["ff-agent-round__art-image", "ff-agent-round__status", "status-moods"]) expect(html).not.toContain(oldArt);
  for (const visible of ["ff-reasoning-status-art is-thinking", "流萤已完成 · 浏览 1 个目录", "流萤正在读取文件",
    "Inspecting directories", "Verifying cancellation", "Checking the result"]) expect(html.includes(visible) || html.replace(/<[^>]+>/g, "").includes(visible)).toBe(true);
});

test("labels interrupted generated text, shows changed-file counts and omits empty rounds", () => {
  const interrupted = draw({ agentRounds: [rounds[1]], interrupted: true,
    processMessages: [{ id: "unfinished", roundId: "verification", content: "Partial inspection", interrupted: true }] });
  expect(interrupted).toContain("未完成的生成内容");
  expect(interrupted).toContain("Partial inspection");
  const changed = draw({ agentRounds: [rounds[0]], tools: [{ id: "patch", roundId: "inspection", name: "str_replace", status: "success",
    changes: [{ file: "lib/guide.ts", kind: "modified", insertions: 6, deletions: 2 }] }] });
  expect(changed).toContain("流萤已完成");
  expect(changed).toContain('class="ff-agent-round__files"');
  expect(changed).toContain("1 个文件已被改动");
  expect(draw({ agentRounds: [rounds[0]] })).not.toContain("ff-agent-round");
  expect(draw({ agentRounds: [rounds[0]], processMessages: [{ id: "visible-narration", roundId: "inspection", content: "Inspection commentary" }],
    tools: [{ id: "scan", roundId: "inspection", name: "list_dir", status: "success" }] })).toContain("Inspection commentary");
});

test("renders delegated task attribution in its owning round", () => {
  const html = draw({ agentRounds: [rounds[1]], taskDelegations: [{
    invocationId: "delegated-check", taskId: "check-guide", roundId: "verification", description: "Check the guide",
    nickname: "银狼", assetFileName: "银狼.png", status: "running",
  }] });
  for (const text of ["流萤委托了", "银狼", "Check the guide"]) expect(html).toContain(text);
});

test("reuses derived bubbles for unchanged messages and invalidates only replaced messages", () => {
  const user: ChatMessageItem = { id: "question-review", role: "user", content: "Inspect the guide" }, assistant = reply({ content: "Partial" });
  const stickers: EnabledSticker[] = [];
  const first = assembleMessageItems([user, assistant], stickers, null);
  const repeated = assembleMessageItems([user, assistant], stickers, first.cache);
  expect(repeated.items).not.toBe(first.items);
  expect(repeated.items[0]).toBe(first.items[0]);
  expect(repeated.items[1]).toBe(first.items[1]);
  const updated = assembleMessageItems([user, { ...assistant, content: "Complete response" }], stickers, repeated.cache);
  expect(updated.items[0]).toBe(first.items[0]);
  expect(updated.items[1]).not.toBe(first.items[1]);
  expect(updated.items[1].content).toBe("Complete response");
});

test("refreshes sticker addresses when the catalog identity changes", () => {
  const user: ChatMessageItem = { id: "sticker-request", role: "user", content: "[sticker:custom-wave]" };
  const catalog = [{ id: "custom-wave", src: "https://assets.invalid/wave-first.png" }];
  const first = assembleMessageItems([user], catalog, null);
  const unchanged = assembleMessageItems([user], catalog, first.cache);
  expect(unchanged.items[0]).toBe(first.items[0]);
  const next = assembleMessageItems([user], [{ id: "custom-wave", src: "https://assets.invalid/wave-next.png" }], unchanged.cache);
  expect(next.items[0]).not.toBe(first.items[0]);
  expect(next.items[0].extraInfo?.stickerUrl).toBe("https://assets.invalid/wave-next.png");
});

test("preserves reasoning/answer item order and identities on cache hits", () => {
  const message = reply({ runId: "review-run", reasoningBlocks: [{ id: "thought-review", content: "Inspect carefully", streaming: false }] });
  const catalog: EnabledSticker[] = [];
  const first = assembleMessageItems([message], catalog, null);
  expect(first.items.map(item => item.key)).toStrictEqual(["reply-review-reasoning-thought-review", "reply-review"]);
  const second = assembleMessageItems([message], catalog, first.cache);
  expect(second.items.map(item => item.key)).toStrictEqual(first.items.map(item => item.key));
  expect(second.items.every((item, index) => item === first.items[index])).toBe(true);
});
