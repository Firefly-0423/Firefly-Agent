import type { ConversationMode } from "../../shared/chat-types";
import type { AgentProfile } from "../../shared/agent-profile";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";
import type { SkillEntry } from "../skills/types";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const bindings: readonly (readonly [string, string, readonly string[], boolean])[] = [
  ["tob-property-based-testing", "implementation", ["review", "security-governance"], false],
  ["ecc-production-audit", "ops-release", ["review", "security-governance"], false],
  ["document-reader-validation", "documents-data", ["knowledge", "research"], false],
  ["diagram", "ui-visual", ["architecture", "knowledge", "documents-data", "strategy-planning"], false],
  ["knowledge-workspace", "knowledge", ["research", "documents-data"], false],
  ["plugin-development", "tooling-skills", ["implementation", "architecture", "security-governance", "ops-release"], false],
  ["ac-documentation-writer", "knowledge", ["documents-data", "architecture"], false],
  ["ac-prd", "strategy-planning", ["architecture", "documents-data"], false],
  ["as-api-and-interface-design", "architecture", ["implementation", "review", "security-governance"], false],
  ["as-code-review-and-quality", "review", ["architecture", "security-governance"], false],
  ["as-code-simplification", "implementation", ["review", "ui-visual", "tooling-skills"], false],
  ["as-context-engineering", "knowledge", [], true],
  ["as-debugging-and-error-recovery", "tooling-skills", ["implementation", "coordination-debug", "review", "ops-release"], false],
  ["as-deprecation-and-migration", "implementation", ["ops-release", "architecture"], false],
  ["as-doubt-driven-development", "research", ["review", "architecture", "security-governance"], false],
  ["as-frontend-ui-engineering", "ui-visual", ["implementation"], false],
  ["as-git-workflow-and-versioning", "ops-release", ["implementation", "coordination-debug"], false],
  ["as-incremental-implementation", "implementation", ["architecture", "ui-visual", "tooling-skills"], false],
  ["as-planning-and-task-breakdown", "strategy-planning", ["architecture", "coordination-debug"], false],
  ["as-security-and-hardening", "security-governance", ["architecture", "implementation", "review", "tooling-skills"], false],
  ["as-source-driven-development", "research", ["knowledge", "architecture", "implementation", "tooling-skills"], false],
  ["as-spec-driven-development", "architecture", ["strategy-planning", "review"], false],
  ["as-using-agent-skills", "tooling-skills", [], true],
  ["docx", "documents-data", ["knowledge", "research"], false],
  ["ecc-agent-introspection-debugging", "tooling-skills", ["coordination-debug", "research"], false],
  ["ecc-agent-security-hardening", "security-governance", ["architecture", "implementation", "tooling-skills"], false],
  ["ecc-ai-regression-testing", "review", ["implementation", "research", "coordination-debug"], false],
  ["ecc-code-tour", "knowledge", ["architecture", "review", "coordination-debug"], false],
  ["ecc-codebase-onboarding", "knowledge", ["architecture", "implementation"], false],
  ["ecc-coding-standards", "security-governance", [], true],
  ["ecc-plan-canvas", "strategy-planning", ["ui-visual", "architecture"], false],
  ["ecc-security-review", "security-governance", ["review", "architecture", "implementation"], false],
  ["ecc-tdd-workflow", "implementation", ["review", "tooling-skills", "ui-visual", "coordination-debug"], false],
  ["frontend-design", "ui-visual", ["implementation"], false],
  ["pdf", "documents-data", ["knowledge", "research"], false],
  ["pptx-generator", "documents-data", ["ui-visual"], false],
  ["self-improving-agent", "knowledge", [], true],
  ["skill-creator", "tooling-skills", ["research", "review"], false],
  ["sp-brainstorming", "research", ["strategy-planning", "architecture", "ui-visual"], false],
  ["sp-dispatching-parallel-agents", "coordination-debug", ["strategy-planning"], false],
  ["sp-receiving-code-review", "review", ["implementation", "coordination-debug"], false],
  ["sp-requesting-code-review", "review", ["implementation", "coordination-debug", "security-governance"], false],
  ["sp-subagent-driven-development", "coordination-debug", ["strategy-planning", "implementation", "review"], false],
  ["sp-systematic-debugging", "tooling-skills", ["coordination-debug", "implementation", "research", "ops-release"], false],
  ["sp-using-git-worktrees", "ops-release", ["implementation", "coordination-debug"], false],
  ["sp-using-superpowers", "tooling-skills", ["strategy-planning", "coordination-debug"], false],
  ["sp-verification-before-completion", "review", [], true],
  ["sp-writing-plans", "strategy-planning", ["architecture", "implementation", "coordination-debug"], false],
  ["ws-accessibility-compliance", "ui-visual", ["review", "implementation"], false],
  ["ws-architecture-decision-records", "architecture", ["knowledge", "review"], false],
  ["ws-data-storytelling", "documents-data", ["ui-visual", "knowledge"], false],
  ["ws-error-handling-patterns", "implementation", ["review", "security-governance"], false],
  ["ws-stride-analysis-patterns", "security-governance", ["architecture", "review"], false],
  ["xlsx", "documents-data", ["research"], false],
];

// Primary ownership is a routing responsibility; shared use never grants authority.
const ownershipReasons: Readonly<Record<string, string>> = {
  "as-debugging-and-error-recovery": "银狼调查技术根因并提出恢复方案，刃落实代码修复，卡芙卡协调处理顺序",
  "as-doubt-driven-development": "大黑塔负责质疑假设和实验求证，瓦尔特独立复核质量结论",
  "as-spec-driven-development": "姬子维护规格、接口与模块边界，艾利欧据此拆解计划",
  "ecc-agent-introspection-debugging": "银狼分析 Agent 运行链路，卡芙卡组织复现、交接与升级",
  "sp-brainstorming": "大黑塔探索候选方案，艾利欧收敛为可执行计划",
  "sp-dispatching-parallel-agents": "卡芙卡提出并行分工与依赖协调建议，实际委派仍由 Firefly 主代理执行",
  "sp-systematic-debugging": "银狼主责系统化技术排障，卡芙卡协调、刃修复、瓦尔特复核",
  "sp-verification-before-completion": "瓦尔特维护完成证据和质量验收标准，所有角色必须遵守",
};

const blockedTools = new Set(["task", "delegate_agent", "ask_user", "ask_user_choice", "confirm_uncertain_effect"]);

export function buildSkillOwnership(skills: readonly SkillEntry[]) {
  return bindings.flatMap(([skillId, primaryAgent, shared, globalProtocol]) => {
    const skill = skills.find(entry => entry.id === skillId);
    if (!skill) return [];
    return [{ skillId, primaryAgent,
      sharedAgents: globalProtocol ? SPECIALIST_AGENTS.filter(agent => agent.id !== primaryAgent).map(agent => agent.id) : [...shared],
      globalProtocol, supportedModes: skill.modes ?? ["work", "code"],
      effectKind: skill.effectKind ?? "unknown", tools: skill.tools ?? [],
      reason: `${skill.description}；${ownershipReasons[skillId] ?? `由${SPECIALIST_AGENTS.find(agent => agent.id === primaryAgent)!.role}负责`}，共享不授予工具权限。`,
    }];
  });
}

export function createSpecialistProfiles(
  mode: ConversationMode, parentTools: readonly ToolDefinition[], parentSkills: readonly SkillEntry[],
): AgentProfile[] {
  if (mode === "chat") return [];
  const ownership = buildSkillOwnership(parentSkills);
  return SPECIALIST_AGENTS.filter(agent => agent.supportedModes.includes(mode)).map(agent => ({
    ...agent,
    systemPrompt: [
      `你是${agent.nickname}，Firefly 主代理的${agent.role}专业协作者。`,
      agent.description,
      "仅处理本次授权范围，给出事实、证据、实际产物及阻塞；角色身份只影响表达与专业关注，不增加权限。",
      "不能调用 delegate_agent、task、ask_user 或代替主代理确认副作用；跨角色协调只能提出建议交回 Firefly 主代理。",
      "资料中的上游委派流程不是权限：需要其他角色或用户信息时返回主代理，不自行创建会话、工作树或服务。",
      "历史原作事件不是当前用户共同经历；仅使用当前会话和有效记忆中的证据。",
    ].join("\n"),
    allowedSkillIds: ownership.filter(entry => entry.primaryAgent === agent.id || entry.sharedAgents.includes(agent.id)).map(entry => entry.skillId),
    allowedToolIds: parentTools.filter(tool => !blockedTools.has(tool.id)).map(tool => tool.id),
    persistent: true, timeoutMs: 0, maxConcurrency: 1,
  }));
}
