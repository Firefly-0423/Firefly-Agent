export interface SpecialistDefinition {
  id: string;
  nickname: string;
  role: string;
  /** 给用户看的一句话简介（设置页角色卡片）；description 是给模型的职责说明，二者不要混用。 */
  intro: string;
  description: string;
  modelProfile: string;
  supportedModes: readonly ("work" | "code")[];
}

export interface AgentRoutingView {
  profiles: Array<{ id: string; label: string }>;
  routes: Array<{ id: string; profileId?: string }>;
  agents: Array<SpecialistDefinition & { overrideProfileId?: string; effectiveProfileId?: string; error?: string }>;
}

export interface AgentRoutingUpdate {
  kind: "agent" | "route";
  id: string;
  profileId: string | null;
}

export const SPECIALIST_AGENTS: readonly SpecialistDefinition[] = [
  { id: "strategy-planning", nickname: "艾利欧", role: "战略与规划", intro: "为星核猎手写下剧本的人，擅长把目标拆成清晰可走的步骤。", description: "目标优先级、任务拆解、依赖与执行计划；协调安排由卡芙卡汇总后交主代理决定", modelProfile: "reasoning", supportedModes: ["work", "code"] },
  { id: "architecture", nickname: "姬子", role: "架构与集成", intro: "修复星穹列车的科学家，温和而有见识，负责把方案落成一致的技术契约。", description: "规格、模块边界、API 与系统集成；将计划转成一致的技术契约", modelProfile: "reasoning", supportedModes: ["work", "code"] },
  { id: "implementation", nickname: "刃", role: "代码实现", intro: "星核猎手的利刃，话不多，专注把代码实现、重构与修复做完。", description: "代码实现、重构、修复与 TDD", modelProfile: "coding", supportedModes: ["work", "code"] },
  { id: "research", nickname: "大黑塔", role: "技术研究", intro: "天才俱乐部第 83 席，爱追有趣的新问题，对无聊的事不会假装热心。", description: "候选方案探索、源码资料研究、假设质疑与实验验证；研究兴趣不替代任务验收标准", modelProfile: "research", supportedModes: ["work", "code"] },
  { id: "knowledge", nickname: "丹恒", role: "知识管理", intro: "星穹列车的护卫，冷静可靠，擅长梳理代码事实与知识。", description: "源码事实、代码库理解、Memory/RAG 与知识整理", modelProfile: "research", supportedModes: ["work", "code"] },
  { id: "review", nickname: "瓦尔特", role: "质量审查", intro: "曾任逆熵盟主，沉稳审慎，负责独立复核与把关质量。", description: "Code Review、回归质量、可靠性和完成证据核验；独立复核实现结果", modelProfile: "reasoning", supportedModes: ["work", "code"] },
  { id: "security-governance", nickname: "星期日", role: "安全治理", intro: "端正克制，守着权限与风险的边界，不替任何角色扩大授权。", description: "安全审查、权限规则、风险与治理边界验收；不能自行扩大任何角色权限", modelProfile: "reasoning", supportedModes: ["work", "code"] },
  { id: "ui-visual", nickname: "三月七", role: "界面与视觉", intro: "爱拍照的开拓者，对画面敏感，负责界面与视觉。", description: "React、UI/UX、图表、视觉与办公主题；与知更鸟协作统一文档表现", modelProfile: "vision", supportedModes: ["work", "code"] },
  { id: "documents-data", nickname: "知更鸟", role: "文档与数据", intro: "匹诺康尼的歌手，把报告、表格与文档整理得清楚动听。", description: "DOCX/PDF/PPTX/XLSX、报告、表格与数据产物", modelProfile: "document", supportedModes: ["work"] },
  { id: "tooling-skills", nickname: "银狼", role: "工具、Skills 与技术排障", intro: "星核猎手里的黑客，擅长工具链，也擅长顺藤摸瓜找到问题的根因。", description: "Skills、插件、工具链、自动化与系统化技术根因调查；不绕过授权和安全边界", modelProfile: "coding", supportedModes: ["work", "code"] },
  { id: "ops-release", nickname: "帕姆", role: "工程运维", intro: "星穹列车的列车长，把构建、发布与日常运维打理得稳稳当当。", description: "Git、worktree、CI、构建、打包、发布检查与费用报表事务；只处理已授权资源", modelProfile: "fast", supportedModes: ["work", "code"] },
  { id: "coordination-debug", nickname: "卡芙卡", role: "执行协调", intro: "星核猎手成员，从容安排分工与节奏，最终委派交由主代理决定。", description: "并行分工、依赖排序、故障复现安排与升级交接建议；技术根因交银狼、实际委派交主代理", modelProfile: "reasoning", supportedModes: ["work", "code"] },
];
