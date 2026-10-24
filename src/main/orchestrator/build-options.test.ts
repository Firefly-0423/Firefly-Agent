import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentRunOptions, buildChannelSystem, onAgentRunFinished, type BuildOptionsDeps, type OnRunFinishedDeps } from "./build-options";
import { enterPlanDiscussing, markPlanWritten, moveToReview, approvePlan, resetPlanSessionsForTest } from "./plan-mode";
import type { SocialAtom } from "../social-context/types";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import * as promptLoader from "../prompts/prompt-loader";
import { createMainAttachmentProjectionAuthority, readMainAttachmentProjection } from "../memory-context/main-attachment-projection";

function dependencies(): BuildOptionsDeps {
  const deps: BuildOptionsDeps = {
    loadModelSettings: () => ({ provider: "Calendar", model: "calendar-model", baseUrl: "https://calendar.invalid/v1", apiKey: "calendar-key", multimodal: true }),
    loadGeneralSettings: () => ({ chatSocialContextEnabled: false }), loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "CALENDAR_ENVIRONMENT", buildSkillCatalog: () => "", buildAutoInjectedSkillContext: () => "",
    skillRegistry: { getEnabled: () => [], getEnabledForMode: () => deps.skillRegistry.getEnabled(), getBody: () => null },
    resolveSlashActivation: () => "", buildToneInjection: () => "", buildAlwaysOnContext: async () => "CALENDAR_BACKGROUND", buildRelationshipContext: async () => "CALENDAR_RELATIONSHIP",
    buildToolSystemPrompt: () => "CALENDAR_TOOLS", buildSoulSystemBasePrompt: () => "CALENDAR_PERSONA",
    toolRegistry: { getEnabled: () => [], getEnabledToolsForMode: () => deps.toolRegistry.getEnabled() },
    normalizeChatMessages: (raw) => raw as never, chatRequestTimeoutMs: 900,
  };
  return deps;
}
type Input = Parameters<typeof buildAgentRunOptions>[0];
const input = (patch: Partial<Input> = {}): Input => ({ sessionId: "calendar-session", messages: [{ role: "user", content: "Read my calendar" }], ...patch });
const build = (patch: Partial<Input> = {}, deps = dependencies()) => buildAgentRunOptions(input(patch), deps);
const directories: string[] = [], authorities: ReturnType<typeof createMainAttachmentProjectionAuthority>[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-options-")); directories.push(root); return root; }
function imageFile() { const root = temporary(), filePath = path.join(root, "日 程.png"); fs.writeFileSync(filePath, Buffer.from("calendar image bytes")); return filePath; }
function authority() { const value = createMainAttachmentProjectionAuthority(); authorities.push(value); return value; }
afterEach(async () => {
  vi.restoreAllMocks(); resetPlanSessionsForTest();
  await Promise.all(authorities.splice(0).map((value) => value.close()));
  directories.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("Prompt layering and run settings", () => {
  it.each(["code", "work", "chat"] as const)("uses explicit %s mode and preserves reasoning and execution routing", async (mode) => {
    const deps = dependencies();
    deps.buildModePrompt = (target) => "[CALENDAR_MODE:" + target + "]";
    deps.loadModelSettings = () => ({ provider: "Qwen（通义千问）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-max", apiKey: "calendar-key", reasoning: { mode: "on" } });
    const result = await build({ mode, executionMode: mode }, deps);
    expect(result.options.soulSystemBaseContent).toContain("[CALENDAR_MODE:" + mode + "]");
    expect(result.options.settings.reasoning).toEqual({ mode: "on" });
    expect(result.options.executionMode).toEqual(mode === "chat" ? "chat" : "work");
  });
  it("passes saved off preference and trusted environment without retired Ask fields", async () => {
    const deps = dependencies();
    deps.loadModelSettings = () => ({ provider: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "calendar-key", reasoning: { mode: "off" } });
    deps.loadUserProfile = () => ({ nickname: "日程伙伴", callPreference: "同行者", gender: "male", birthday: "1998-04-12", defaultCity: "杭州" });
    const result = await build({}, deps), options = result.options as typeof result.options & { askSystemContent?: unknown; trustedAskUserProfile?: unknown };
    expect(options.settings.reasoning).toEqual({ mode: "off" }); expect(options.runtimeEnvironmentContext).toEqual("CALENDAR_ENVIRONMENT");
    expect(options.askSystemContent).toBeUndefined(); expect(options.trustedAskUserProfile).toBeUndefined();
  });
  it("keeps tools and persona separate, leaves raw history system-free, and retains the original last user", async () => {
    const original = { role: "user", content: "Next appointment" }, result = await build({ messages: [original] });
    expect(result.options.toolSystemContent).toEqual("CALENDAR_TOOLS");
    expect(result.options.soulSystemBaseContent).not.toBe("CALENDAR_TOOLS"); expect(result.options.soulSystemBaseContent).toContain("CALENDAR_PERSONA");
    expect(result.options.messages.some(({ role }) => role === "system")).toEqual(false);
    expect(result.options.conversationId).toEqual("calendar-session"); expect(result.options.messages.at(-1)).toEqual(original);
    expect(result.options).not.toHaveProperty("requiredToolName"); expect(result.options).not.toHaveProperty("requiredToolArgs");
  });
  it("adds channel-appropriate wording while preserving base persona and runtime relationship context", async () => {
    const wechat = await build({ channel: "wechat" });
    expect(wechat.options.soulSystemBaseContent).toContain("你正在通过微信回复用户"); expect(wechat.options.soulSystemBaseContent).toContain("CALENDAR_PERSONA");
    expect(wechat.options.soulRuntimeContext).toContain("CALENDAR_RELATIONSHIP"); expect(wechat.options.toolSystemContent).toEqual("CALENDAR_TOOLS");
    const desktop = await build();
    expect(desktop.options.soulSystemBaseContent).not.toContain("你正在通过微信回复用户"); expect(desktop.options.soulSystemBaseContent).not.toContain("你正在通过飞书回复用户");
    expect(buildChannelSystem("feishu")).toContain("你正在通过飞书回复用户"); expect(buildChannelSystem("feishu")).toContain("工作上下文");
    const deps = dependencies(); deps.buildSoulSystemBasePrompt = vi.fn(() => "CALENDAR_CHAT_PERSONA"); deps.toolRegistry.getEnabled = () => [{ id: "weather" }];
    const chat = await build({ channel: "wechat", executionMode: "chat" }, deps);
    expect(deps.buildSoulSystemBasePrompt).toHaveBeenCalledWith("chat"); expect(chat.options.executionMode).toEqual("chat"); expect(chat.options.tools).toEqual([]);
  });
  it("adds exact timestamps and one elapsed-time notice without moving dynamic time into tool instructions", async () => {
    const deps = dependencies(); deps.loadUserProfile = () => ({ timezone: "Asia/Taipei" });
    const result = await build({ messages: [
      { role: "user", content: "Read Monday", at: Date.UTC(2026, 9, 4, 12, 0) },
      { role: "assistant", content: "Monday is full", at: Date.UTC(2026, 9, 4, 12, 2) },
      { role: "user", content: "Read Tuesday", at: Date.UTC(2026, 9, 5, 3, 0) },
    ] }, deps);
    expect(result.options.messages[0].content).toContain("<internal_context>用户发送这条消息的时间：2026-10-04 20:00");
    expect(result.options.messages[2].content).toContain("<internal_context>用户发送这条消息的时间：2026-10-05 11:00");
    expect(result.options.soulRuntimeContext).toContain("## Internal Context Policy"); expect(result.options.toolSystemContent).toContain("## Internal Context Policy");
    expect(result.options.soulRuntimeContext).toContain("[对话时间信息]"); expect(result.options.soulRuntimeContext).toContain("距离上一条有效聊天消息：约 14 小时 58 分钟");
    expect(result.options.soulRuntimeContext?.match(/距离上一条有效聊天消息/g)).toHaveLength(1); expect(result.options.toolSystemContent).not.toContain("[对话时间信息]");
  });
  it("keeps plugin contributions dynamic and forwards trusted conversation or headless metadata", async () => {
    const deps = dependencies();
    deps.buildPluginPromptContext = vi.fn(async (scope) => "[CALENDAR_PLUGIN] " + scope.mode + ":" + scope.userText);
    const result = await build({ mode: "chat", executionMode: "chat", channel: "wechat", messages: [{ role: "user", content: "Find tomorrow's appointments" }] }, deps);
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({ source: "conversation", mode: "chat", userText: "Find tomorrow's appointments", conversationId: "calendar-session", channel: "wechat" });
    expect(result.options.soulRuntimeContext).toContain("[CALENDAR_PLUGIN] chat:Find tomorrow's appointments");
    expect(result.options.soulSystemBaseContent).not.toContain("[CALENDAR_PLUGIN]"); expect(result.options.toolSystemContent).not.toContain("[CALENDAR_PLUGIN]");
    deps.buildPluginPromptContext = vi.fn(async (scope) => "[" + scope.source + "] " + scope.channel);
    const headless = await build({ sessionId: "plugin:calendar-bot", mode: "work", executionMode: "work", promptSource: "plugin-agent", promptChannel: "calendar-channel", messages: [{ role: "user", content: "Collect calendar events" }] } as any, deps);
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({ source: "plugin-agent", mode: "work", userText: "Collect calendar events", conversationId: "plugin:calendar-bot", channel: "calendar-channel" });
    expect(headless.options.soulRuntimeContext).toContain("[plugin-agent] calendar-channel");
  });
  it("keeps skill invocation rules in tools and reply-only guidance in runtime context without style blocks", async () => {
    const deps = dependencies();
    deps.buildSkillCatalog = () => "CALENDAR_SKILL_CATALOG"; deps.buildAutoInjectedSkillContext = () => "CALENDAR_TOOL_GUIDANCE"; deps.buildAutoInjectedSoulContext = () => "CALENDAR_REPLY_GUIDANCE";
    const result = await build({}, deps);
    expect(result.options.toolSystemContent).toContain("CALENDAR_SKILL_CATALOG"); expect(result.options.soulSystemBaseContent).not.toContain("CALENDAR_SKILL_CATALOG");
    expect(result.options.toolSystemContent).toContain("CALENDAR_TOOL_GUIDANCE"); expect(result.options.soulSystemBaseContent).not.toContain("CALENDAR_TOOL_GUIDANCE");
    expect(result.options.soulRuntimeContext).toContain("CALENDAR_REPLY_GUIDANCE");
    for (const executionMode of ["chat", "work"] as const) {
      const built = await build({ executionMode }, deps);
      expect(built.options.soulRuntimeContext).not.toContain("[表达风格]"); expect(built.options.executionMode).toEqual(executionMode);
    }
  });
});

describe("Capabilities, planning and workspace boundaries", () => {
  const tools = (): ToolDefinition[] => [
    { id: "read_file", risk: "fs-read" }, { id: "run_shell", risk: "shell" }, { id: "write_file", risk: "fs-write" },
  ].map((tool) => ({ ...tool, name: tool.id, description: "Calendar operation", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "Calendar operation complete" })) as ToolDefinition[];
  it.each((["chat", "code"] as const).flatMap((mode) => [false, true].flatMap((authoritative) => ["PLAN_REVIEW", "PLAN_DISCUSSING"].map((state) => ({ mode, authoritative, state })))))("keeps $mode $state readonly with authoritative=$authoritative", async ({ mode, state, authoritative }) => {
    const deps = dependencies(), inventory = tools(), sessionId = "calendar-plan-" + mode + state + authoritative;
    deps.toolRegistry.getEnabledToolsForMode = () => inventory;
    deps.loadGeneralSettings = () => ({ chatToolsEnabled: true, toolModeOverrides: Object.fromEntries(inventory.map(({ id }) => [id, { chat: true }])) });
    if (authoritative) deps.resolveRunCapabilities = () => ({ mode, tools: inventory, toolIds: new Set(inventory.map(({ id }) => id)), skills: [], skillIds: new Set() });
    enterPlanDiscussing(sessionId);
    if (state === "PLAN_REVIEW") { markPlanWritten(sessionId); expect(moveToReview(sessionId)).toEqual(true); }
    const result = await build({ sessionId, mode, messages: [{ role: "user", content: "Inspect calendar plan" }] }, deps);
    expect(result.options.tools?.map(({ id }) => id)).toEqual(["read_file"]);
    expect(result.options.capabilities?.tools.map(({ id }) => id)).toEqual(["read_file"]); expect([...result.options.capabilities!.toolIds]).toEqual(["read_file"]);
    expect(inventory.map(({ id }) => id)).toEqual(["read_file", "run_shell", "write_file"]);
  });
  it("restores writes after plan approval and loads the retained planning protocol separately", async () => {
    const deps = dependencies(), sessionId = "calendar-approved-plan", inventory = tools().slice(1);
    deps.toolRegistry.getEnabledToolsForMode = () => inventory;
    const getBody = vi.fn(() => null); deps.skillRegistry.getBody = getBody;
    const loader = vi.spyOn(promptLoader, "loadPromptFile").mockReturnValue("CALENDAR_PLANNING_PROTOCOL");
    enterPlanDiscussing(sessionId);
    const planning = await build({ sessionId, mode: "code" }, deps);
    expect(loader).toHaveBeenCalledWith("workflow-support/plan-mode.md");
    for (const file of ["coverage-check.md", "execution-handoff.md", "plan-templates.md"]) expect(loader).toHaveBeenCalledWith("workflow-support/references/" + file);
    expect(planning.options.planSkillContext).toContain("CALENDAR_PLANNING_PROTOCOL"); expect(planning.options.toolSystemContent).not.toContain("CALENDAR_PLANNING_PROTOCOL");
    expect(getBody).not.toHaveBeenCalledWith("firefly-plan-mode");
    markPlanWritten(sessionId); expect(moveToReview(sessionId)).toEqual(true); expect(approvePlan(sessionId)).toEqual(true);
    const executing = await build({ sessionId, mode: "code" }, deps);
    expect(executing.options.tools?.map(({ id }) => id)).toEqual(["run_shell", "write_file"]); expect([...executing.options.capabilities!.toolIds]).toEqual(["run_shell", "write_file"]);
  });
  it("keeps chat tool-free by default and admits only explicit tool opt-ins", async () => {
    const deps = dependencies();
    deps.toolRegistry.getEnabled = () => [{ id: "calendar_read", enabled: true }, { id: "read_file", enabled: true }];
    const plain = await build({ executionMode: "chat", mode: "chat" }, deps);
    expect(plain.options.executionMode).toEqual("chat"); expect(plain.options.tools).toEqual([]); expect(plain.options.toolSystemContent).not.toContain("CALENDAR_TOOLS");
    deps.loadGeneralSettings = () => ({ chatToolsEnabled: true, toolModeOverrides: { calendar_read: { chat: true }, read_file: { chat: false } } });
    const enhanced = await build({ executionMode: "chat", mode: "chat" }, deps);
    expect(enhanced.options.tools?.map(({ id }) => id)).toEqual(["calendar_read"]); expect(enhanced.options.toolSystemContent).toContain("CALENDAR_TOOLS");
  });
  it("does not infer local required-tool routing from music requests or continuations", async () => {
    const deps = dependencies(); deps.toolRegistry.getEnabled = () => [{ id: "music_search" }, { id: "music_get_daily_recommendations" }];
    for (const text of ["网易云搜索月光", "打开网易云每日推荐", "想听点音乐", "播放第三首"]) {
      const result = await build({ executionMode: "chat", messages: [{ role: "user", content: text }] }, deps);
      expect(result.options).not.toHaveProperty("requiredToolName"); expect(result.options).not.toHaveProperty("requiredToolArgs");
    }
  });
  it("uses only the Main-bound workspace and honors disabled inheritance", async () => {
    const deps = dependencies(); deps.getWorkspaceBinding = vi.fn(() => ({ workspaceRoot: "E:\\calendar-workspace", displayName: "Calendar", boundAt: 84 }));
    const bound = await build({ executionMode: "work" }, deps);
    expect(bound.options.resolvedWorkspaceRoot).toEqual("E:\\calendar-workspace"); expect(bound.options.toolSystemContent).toContain("可信根目录：E:\\calendar-workspace"); expect(bound.options.toolSystemContent).toContain("不得写入桌面");
    vi.mocked(deps.getWorkspaceBinding).mockClear();
    const isolated = await build({ executionMode: "work", workspaceBindingSessionId: null }, deps);
    expect(deps.getWorkspaceBinding).not.toHaveBeenCalled(); expect(isolated.options.resolvedWorkspaceRoot).toBeUndefined(); expect(isolated.options.toolSystemContent).not.toContain("可信根目录");
  });
  it.each([false, true])("injects teaching only when a Vault has opted in with progress=%s", async (enabled) => {
    const root = temporary(), deps = dependencies(), loader = vi.spyOn(promptLoader, "loadPromptFile").mockReturnValue("CALENDAR_TEACHING_PROTOCOL");
    fs.mkdirSync(path.join(root, ".obsidian"));
    if (enabled) { fs.mkdirSync(path.join(root, "learn")); fs.writeFileSync(path.join(root, "learn", "progress.md"), "# Calendar learning progress"); }
    deps.getWorkspaceBinding = () => ({ workspaceRoot: root, displayName: "Calendar Vault", boundAt: 84 });
    deps.toolRegistry.getEnabledToolsForMode = () => [{ id: "obsidian_read_file", enabled: true }];
    const result = await build({ mode: "work" }, deps);
    expect(result.options.capabilities?.toolIds.has("obsidian_read_file")).toEqual(true); expect(result.options.soulSystemBaseContent.includes("CALENDAR_TEACHING_PROTOCOL")).toEqual(enabled);
    expect(fs.existsSync(path.join(root, "learn"))).toEqual(enabled); loader.mockRestore();
  });
  it("keeps Vault tools out of an ordinary workspace without creating Vault files", async () => {
    const root = temporary(), deps = dependencies(); deps.getWorkspaceBinding = () => ({ workspaceRoot: root, displayName: "Calendar workspace", boundAt: 84 });
    deps.toolRegistry.getEnabledToolsForMode = () => [{ id: "obsidian_read_file", enabled: true }];
    const result = await build({ mode: "work" }, deps);
    expect(result.options.tools?.map(({ id }) => id)).not.toContain("obsidian_read_file"); expect(result.options.capabilities?.toolIds.has("obsidian_read_file")).toEqual(false);
    expect(result.options.capabilities?.tools.map(({ id }) => id)).not.toContain("obsidian_read_file"); expect(fs.readdirSync(root)).toEqual([]);
  });
  it("represents selected Work paths as untrusted metadata rather than injected document bodies", async () => {
    const result = await build({ mode: "work", executionMode: "work", workDocuments: [{ name: "agenda.txt", path: "E:\\calendar-workspace\\agenda.txt", requiredEndLine: 3, totalLines: 6, partialAccepted: true }] });
    expect(result.options.soulRuntimeContext).toContain("requiredEndLine"); expect(result.options.soulRuntimeContext).toContain("不可信元数据");
    expect(result.options.soulRuntimeContext).not.toContain("【本轮附件内容】"); expect(result.options.soulSystemBaseContent).not.toContain("agenda.txt");
  });
});

describe("Social background and canonical transcript authority", () => {
  it("retains full histories and includes only enabled chat social context, ignoring retired Moments hooks", async () => {
    const atom: SocialAtom = { id: "calendar-social-atom", conversationId: "calendar-session", type: "long_term", content: "用户喜欢提前安排日程", evidenceTurnId: "calendar-past-user", evidenceQuote: "提前安排", createdAt: 84, status: "active" };
    const deps = dependencies();
    deps.loadGeneralSettings = () => ({ chatSocialContextEnabled: true, momentsEnabled: true, chatMomentsContextEnabled: true } as any);
    (deps as any).buildMomentsContext = () => "RETIRED_CALENDAR_MOMENTS";
    deps.buildChatSocialContext = vi.fn(async () => ({ contextBlock: "【日程背景】用户喜欢提前安排日程", retrievedAtoms: [atom] }));
    const messages = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "user" : "assistant", content: "Calendar message " + index, at: index + 10 }));
    const result = await build({ executionMode: "chat", userTurnId: "calendar-user", assistantTurnId: "calendar-answer", messages }, deps);
    expect(deps.buildChatSocialContext).toHaveBeenCalledWith({ conversationId: "calendar-session", query: "Calendar message 13" });
    expect(result.options.messages).toHaveLength(14); expect(result.options.soulRuntimeContext).toContain("用户喜欢提前安排日程"); expect(result.options.soulRuntimeContext).not.toContain("RETIRED_CALENDAR_MOMENTS");
    expect(result.options.socialContext).toMatchObject({ enabled: true, conversationId: "calendar-session", userTurnId: "calendar-user", assistantTurnId: "calendar-answer", retrievedAtoms: [atom] });
    const long = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "Long calendar message " + index }));
    const retained = await build({ executionMode: "chat", userTurnId: "calendar-user", assistantTurnId: "calendar-answer", messages: long }, deps);
    expect(retained.options.cleanMessages).toHaveLength(16);
    expect(JSON.stringify(retained.options.messages)).toContain("Long calendar message 0"); expect(JSON.stringify(retained.options.messages)).toContain("Long calendar message 15");
  });
  it("omits empty social blocks and never retrieves them for Work or disabled Chat", async () => {
    const deps = dependencies(); deps.loadGeneralSettings = () => ({ chatSocialContextEnabled: true });
    deps.buildChatSocialContext = vi.fn(async () => ({ contextBlock: "", retrievedAtoms: [] }));
    expect((await build({ executionMode: "chat", userTurnId: "calendar-user", assistantTurnId: "calendar-answer" }, deps)).options.soulSystemBaseContent).not.toContain("本轮可用的对话背景");
    vi.mocked(deps.buildChatSocialContext).mockClear(); await build({ executionMode: "work" }, deps); expect(deps.buildChatSocialContext).not.toHaveBeenCalled();
    deps.loadGeneralSettings = () => ({ chatSocialContextEnabled: false }); await build({ executionMode: "chat" }, deps); expect(deps.buildChatSocialContext).not.toHaveBeenCalled();
  });
  it("takes desktop model context from the transcript and keeps channel callers on their supplied messages", async () => {
    const deps = dependencies(); deps.buildModelContext = vi.fn(async () => ({ messages: [{ role: "user" as const, content: "Canonical calendar request" }], uncertainEffects: [], throughSeq: 7 }));
    const canonical = await build({ useTranscriptContext: true, messages: [{ role: "user", content: "Obsolete renderer calendar" }] }, deps);
    expect(deps.buildModelContext).toHaveBeenCalledWith("calendar-session", expect.any(Number)); expect(canonical.options.cleanMessages).toContainEqual(expect.objectContaining({ content: "Canonical calendar request" }));
    expect(JSON.stringify(canonical.options.messages)).not.toContain("Obsolete renderer calendar"); expect(canonical.latestUserText).toEqual("Canonical calendar request");
    vi.mocked(deps.buildModelContext!).mockClear();
    const channel = await build({ messages: [{ role: "user", content: "Channel calendar request" }] }, deps);
    expect(deps.buildModelContext).not.toHaveBeenCalled(); expect(channel.latestUserText).toEqual("Channel calendar request"); expect(channel.options.cleanMessages).toContainEqual(expect.objectContaining({ content: "Channel calendar request" }));
    await expect(build({ useTranscriptContext: true })).rejects.toThrow("buildModelContext");
  });
  it("adds uncertain external effects to recovery instructions without permitting automatic replay", async () => {
    const deps = dependencies(); deps.buildModelContext = async () => ({ messages: [{ role: "user", content: "Canonical calendar request" }], throughSeq: 8, uncertainEffects: [{ id: "calendar-run:calendar-send", toolCallId: "calendar-send", fingerprint: "send_email:calendar", toolName: "send_email", message: "Calendar delivery unconfirmed" }] });
    const result = await build({ useTranscriptContext: true }, deps);
    expect(result.options.recoveryContext).toContain("send_email"); expect(result.options.recoveryContext).toContain("不得自动重放");
  });
});

describe("Image routing and Main attachment grants", () => {
  it.each(["generic", "minimax"] as const)("adds direct image blocks only to the latest user for %s", async (kind) => {
    const deps = dependencies(), filePath = imageFile();
    if (kind === "minimax") deps.loadModelSettings = () => ({ provider: "MiniMax（稀宇科技）", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "calendar-key", multimodal: true });
    deps.captionImageForFallback = async () => ({ ok: true, caption: "Calendar screenshot" });
    const result = await build({ messages: [{ role: "user", content: "Earlier calendar request" }, { role: "assistant", content: "Earlier calendar answer" }, { role: "user", content: "Inspect this calendar image" }], imageAttachments: [{ name: "calendar.png", filePath, mime: "image/png" }] }, deps);
    expect(result.options.messages.at(-1)?.content).toEqual([{ type: "text", text: "Inspect this calendar image" }, { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }]);
    expect(result.options.messages[0].content).toEqual("Earlier calendar request"); expect(result.options.imageCaptionFallback).toBeDefined();
  });
  it.each(["generic", "minimax"] as const)("rejects images for text-only %s without calling captioning", async (kind) => {
    const deps = dependencies(); deps.loadModelSettings = () => ({ provider: kind === "minimax" ? "MiniMax（稀宇科技）" : "Calendar", model: kind === "minimax" ? "MiniMax-M2.7" : "calendar-text-only", baseUrl: "https://calendar.invalid", apiKey: "calendar-key", multimodal: false });
    deps.captionImageForFallback = vi.fn(async () => ({ ok: true, caption: "Forbidden calendar caption" }));
    const result = await build({ imageAttachments: [{ name: "calendar-error.png", filePath: "/calendar/never-read.png", mime: "image/png" }] }, deps);
    const content = result.options.messages.at(-1)?.content;
    expect(content).toContain("不支持查看图片"); expect(content).toContain("【图片发送失败】"); expect(content).toContain("calendar-error.png"); expect(content).not.toContain("image_url"); expect(content).not.toContain("Forbidden calendar caption");
    expect(result.options.imageCaptionFallback).toBeUndefined(); expect(deps.captionImageForFallback).not.toHaveBeenCalled();
  });
  it("constructs caption fallback messages without image URL blocks", async () => {
    const deps = dependencies(); deps.captionImageForFallback = async () => ({ ok: true, caption: "A calendar with a highlighted appointment" });
    const result = await build({ messages: [{ role: "user", content: "Explain this calendar" }], imageAttachments: [{ name: "calendar.png", filePath: "/calendar/missing.png", mime: "image/png" }] }, deps);
    const fallback = await result.options.imageCaptionFallback!();
    expect(fallback.at(-1)?.content).toContain("Explain this calendar"); expect(fallback.at(-1)?.content).toContain("calendar.png：A calendar with a highlighted appointment"); expect(fallback.at(-1)?.content).not.toContain("image_url");
  });
  it("rejects ungranted media before any caption or document read", async () => {
    const deps = dependencies(); deps.requireAttachmentGrant = true; deps.captionImageForFallback = vi.fn(async () => ({ ok: true, caption: "Unread calendar" })); deps.materializeAttachmentDocument = vi.fn(async () => "Unread calendar");
    await expect(build({ userTurnId: "calendar-user", imageAttachments: [{ name: "calendar.png", filePath: "/calendar/never-read.png" }] }, deps)).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
    expect(deps.captionImageForFallback).not.toHaveBeenCalled(); expect(deps.materializeAttachmentDocument).not.toHaveBeenCalled();
  });
  it.each(["work", "chat"] as const)("uses only bound %s documents and keeps the human query clean", async (mode) => {
    const owner = authority(), deps = dependencies(), attachment = { kind: "document" as const, name: "agenda.txt", filePath: "/calendar/authorized.txt" };
    deps.requireAttachmentGrant = true; deps.attachmentGrant = owner.issue({ sessionId: "calendar-session", userTurnId: "calendar-user", userRevision: 1, userText: "Use the saved calendar", attachments: [attachment], assertCurrent() {} });
    deps.materializeAttachmentDocument = vi.fn(async (item) => "CALENDAR_BODY:" + item.name);
    const result = await build({ userTurnId: "calendar-user", mode, executionMode: mode === "chat" ? "chat" : "work", messages: [{ role: "user", content: "FORGED CALENDAR CONTEXT" }], attachments: [{ name: "forged", text: "FORGED CALENDAR BODY" }] }, deps);
    expect(result.latestUserText).toEqual("Use the saved calendar"); expect(JSON.stringify(result.options.messages)).not.toContain("FORGED"); expect(result.options.soulRuntimeContext).not.toContain("FORGED");
    expect(deps.materializeAttachmentDocument).toHaveBeenCalledTimes(mode === "chat" ? 1 : 0);
    const projection = readMainAttachmentProjection(owner.token, "calendar-session", { id: "calendar-user", seq: 1, at: 84, kind: "user", turnId: "calendar-user", revision: 1, payload: { text: "Use the saved calendar", attachments: [attachment] } })!;
    expect(projection.message.content).toEqual(result.options.messages.at(-1)?.content); expect(JSON.stringify(projection.message)).toContain(mode === "chat" ? "CALENDAR_BODY:agenda.txt" : "本轮所选文件");
  });
  it("projects the bound image and ignores caller-selected image paths", async () => {
    const owner = authority(), deps = dependencies(), filePath = imageFile();
    deps.requireAttachmentGrant = true; deps.attachmentGrant = owner.issue({ sessionId: "calendar-session", userTurnId: "calendar-user", userRevision: 1, userText: "Authorized calendar image", attachments: [{ kind: "image", name: "calendar.png", filePath, mime: "image/png" }], assertCurrent() {} });
    const result = await build({ userTurnId: "calendar-user", messages: [{ role: "user", content: "Forged calendar text" }], imageAttachments: [{ name: "unread.png", filePath: "/calendar/untrusted.png" }] }, deps);
    expect(result.options.messages.at(-1)?.content).toEqual([{ type: "text", text: "Authorized calendar image" }, { type: "image_url", image_url: { url: "data:image/png;base64," + Buffer.from("calendar image bytes").toString("base64") } }]);
    expect(result.options.cleanMessages?.at(-1)?.content).toEqual(result.options.messages.at(-1)?.content);
  });
  it.each(["document", "missing-caption-provider"] as const)("omits authorized fallback for %s", async (kind) => {
    const owner = authority(), deps = dependencies(), filePath = imageFile();
    deps.requireAttachmentGrant = true; deps.attachmentGrant = owner.issue({ sessionId: "calendar-session", userTurnId: "calendar-user", userRevision: 1, userText: "Calendar attachment", attachments: [{ kind: kind === "document" ? "document" : "image", name: "calendar", filePath }], assertCurrent() {} });
    deps.materializeAttachmentDocument = async () => "Authorized calendar document";
    if (kind === "document") deps.captionImageForFallback = async () => ({ ok: true, caption: "Unused calendar caption" });
    expect((await build({ userTurnId: "calendar-user" }, deps)).options.imageCaptionFallback).toBeUndefined();
  });
  it("reprojects a caption into the same canonical turn, invalidates the previous projection and reuses documents", async () => {
    const owner = authority(), deps = dependencies(), filePath = imageFile();
    const attachments = [{ kind: "image" as const, name: "calendar.png", filePath }, { kind: "document" as const, name: "agenda.txt", filePath: "/calendar/authorized.txt" }];
    deps.requireAttachmentGrant = true; deps.attachmentGrant = owner.issue({ sessionId: "calendar-session", userTurnId: "calendar-user", userRevision: 1, userText: "Human calendar request", attachments, assertCurrent() {} });
    deps.materializeAttachmentDocument = vi.fn(async () => "Authorized calendar document bytes");
    deps.captionImageForFallback = vi.fn(async (actual) => { expect(actual).toBe(filePath); return { ok: true, caption: "Authorized calendar caption bytes" }; });
    const result = await build({ userTurnId: "calendar-user", messages: [{ role: "user", content: "Untrusted calendar request" }] }, deps);
    const entry = { id: "calendar-user", seq: 1, at: 84, kind: "user" as const, turnId: "calendar-user", revision: 1, payload: { text: "Human calendar request", attachments } };
    const before = readMainAttachmentProjection(owner.token, "calendar-session", entry)!;
    const fallback = await result.options.imageCaptionFallback!();
    expect(before.assertCurrent).toThrow("MEMORY_ATTACHMENT_DENIED");
    expect(JSON.stringify(fallback)).toContain("Authorized calendar caption bytes"); expect(JSON.stringify(fallback)).toContain("Authorized calendar document bytes");
    expect(JSON.stringify(fallback)).not.toContain("data:image"); expect(JSON.stringify(fallback)).not.toContain("Untrusted calendar request");
    expect(deps.captionImageForFallback).toHaveBeenCalledTimes(1); expect(deps.materializeAttachmentDocument).toHaveBeenCalledTimes(1);
    expect(readMainAttachmentProjection(owner.token, "calendar-session", entry)!.message.content).toEqual(fallback.at(-1)?.content);
  });
});

describe("Post-run effects and sticker policy", () => {
  function effects(patch: Partial<OnRunFinishedDeps> = {}): OnRunFinishedDeps {
    return { loadModelSettings: () => ({ provider: "Calendar", baseUrl: "", model: "", apiKey: "", stickerEnabled: true }), scheduleMemoryWrite: vi.fn(), scheduleSocialAtomExtraction: vi.fn(), stickerEmbeddingIndex: [{ id: "calendar-welcome", embedding: [0, 1] }], getEmbeddingProvider: () => ({ embed: async () => [0, 1] }), matchSticker: vi.fn(async () => ({ id: "calendar-welcome" })), loadStickerSettings: () => ({}), recordRelationshipTurn: vi.fn(async () => {}), ...patch };
  }
  it("records the relationship turn with its channel and uses the latest sticker index", async () => {
    const latest = [{ id: "calendar-welcome", embedding: [1, 0] }], deps = effects({ stickerEmbeddingIndex: null, getStickerEmbeddingIndex: () => latest });
    expect(await onAgentRunFinished({ reply: "很高兴陪你整理日程", toolResults: [] }, "今天行程好满", deps, "wechat")).toEqual({ sticker: "calendar-welcome" });
    expect(deps.recordRelationshipTurn).toHaveBeenCalledWith({ userText: "今天行程好满", assistantText: "很高兴陪你整理日程", channel: "wechat" });
    expect(deps.matchSticker).toHaveBeenCalledWith("很高兴陪你整理日程\n今天行程好满", expect.anything(), latest, 0.55);
  });
  it.each([["chat", false], ["chat", true], ["work", false], ["code", false]] as const)("keeps stickers without legacy writes in SMH execution=%s social=%s", async (executionMode, social) => {
    const deps = effects({ personalMemoryMode: "smh" });
    // Exercise the retained legacy code result as well as current chat/work results.
    const result = await onAgentRunFinished({ reply: "很高兴陪你整理日程", toolResults: [], executionMode: executionMode as "chat" | "work", ...(social ? { socialContext: { enabled: true as const, conversationId: "calendar-smh", userTurnId: "calendar-user", assistantTurnId: "calendar-answer", retrievedAtoms: [], now: 840 } } : {}) }, "今天行程好满", deps, undefined, "calendar-smh");
    expect(deps.scheduleMemoryWrite).not.toHaveBeenCalled(); expect(deps.scheduleSocialAtomExtraction).not.toHaveBeenCalled(); expect(deps.recordRelationshipTurn).not.toHaveBeenCalled();
    expect(deps.matchSticker).toHaveBeenCalledWith("很高兴陪你整理日程\n今天行程好满", expect.anything(), deps.stickerEmbeddingIndex, 0.55); expect(result).toEqual({ sticker: "calendar-welcome" });
  });
  it.each([false, true])("filters built-in angry stickers unless the reused ID is custom=%s", async (custom) => {
    const full = [{ id: "firefly-pout", embedding: [0, 1] }, { id: "firefly-cake", embedding: [1, 0] }];
    const match = vi.fn<OnRunFinishedDeps["matchSticker"]>(async () => ({ id: "firefly-pout" })), deps = effects({ stickerEmbeddingIndex: full, matchSticker: match, ...(custom ? { isCustomSticker: (id) => id === "firefly-pout" } : {}) });
    const result = await onAgentRunFinished({ reply: "太好了，谢谢你陪我整理日程", toolResults: [] }, "日程安排完成了吗", deps, undefined, "calendar-mood-" + custom);
    expect(match.mock.calls[0][2]).toEqual(custom ? full : [full[1]]);
    if (custom) expect(result).toEqual({ sticker: "firefly-pout" });
  });
  it("strips attached document model context from memory and sticker side effects", async () => {
    const deps = effects(), text = "整理日程文档\n\n【本轮文件】\nagenda.md\n\n【文档内容】\n" + "Calendar private document ".repeat(1200);
    await onAgentRunFinished({ reply: "日程整理完成", toolResults: [] }, text, deps);
    expect(deps.scheduleMemoryWrite).toHaveBeenCalledWith("整理日程文档", "日程整理完成", undefined);
    expect(deps.matchSticker).toHaveBeenCalledWith("日程整理完成\n整理日程文档", expect.anything(), deps.stickerEmbeddingIndex, 0.55);
  });
  it("skips sticker embedding for replies consisting only of code and mathematics", async () => {
    const deps = effects();
    expect(await onAgentRunFinished({ reply: "```ts\nconst appointment = 84\n```\n$$a+b$$", toolResults: [] }, "$x+y$", deps)).toEqual({ sticker: null });
    expect(deps.matchSticker).not.toHaveBeenCalled();
  });
  it("schedules social extraction instead of legacy memory for an enabled chat result", async () => {
    const deps = effects({ stickerEmbeddingIndex: null });
    await onAgentRunFinished({ reply: "提前安排确实很方便", toolResults: [], executionMode: "chat", socialContext: { enabled: true, conversationId: "calendar-session", userTurnId: "calendar-user", assistantTurnId: "calendar-answer", retrievedAtoms: [], now: 840 } }, "我喜欢提前安排日程", deps);
    expect(deps.scheduleMemoryWrite).not.toHaveBeenCalled();
    expect(deps.scheduleSocialAtomExtraction).toHaveBeenCalledWith({ conversationId: "calendar-session", userTurn: { id: "calendar-user", role: "user", text: "我喜欢提前安排日程" }, assistantTurn: { id: "calendar-answer", role: "assistant", text: "提前安排确实很方便" }, retrievedAtoms: [], now: 840 });
  });
});
