import { TASK_CHARACTERS } from "../../shared/task-characters";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";
export { TASK_CHARACTERS } from "../../shared/task-characters";
export type TaskCharacterLease = { release(): void; nickname: string; assetFileName: string };

export function getTaskCompanionNames(): readonly string[] {
  return Array.from(TASK_CHARACTERS, (portrait) => portrait.nickname);
}
export function buildTaskCompanionPrompt(conversationMode: "work" | "code" = "work"): string {
  const availableRoles = SPECIALIST_AGENTS.filter((role) => role.supportedModes.includes(conversationMode));
  if (!availableRoles.length) return "";
  const lines = ["当前模式的专业 Agent（任何一位都可以委托）："];
  for (const role of availableRoles) lines.push(`- ${role.id}（${role.nickname}）：${role.role}。${role.description}`);
  lines.push("仅在工具可用时由主 Agent 调用 delegate_agent，参数只有 agent_id 和 prompt。","选择方式：先判断任务主要属于哪个领域，只先委托最主责的那一位；等它的结果回来，若任务跨领域或结果不足，再继续委托其他角色。需要几位就依次委托几位，每次调用传入完整的 prompt，必要时把前一位的结论写进去。不要一次性委托全部角色；简单任务由主 Agent 自己完成。","角色不授予权限，工具与 Skills 必须在父运行授权范围内。子 Agent 不得再次委派、询问用户或确认父级副作用；不要编造角色与当前用户的共同经历。");
  return lines.join("\n");
}

export class TaskCharacterLeasePool {
  private readonly conversationLeases = new Map<string, Set<string>>();

  acquire(conversationKey: string, requestedName: string): TaskCharacterLease {
    const reserved = this.conversationLeases.get(conversationKey) ?? new Set<string>();
    const portrait = TASK_CHARACTERS.find((candidate) => candidate.nickname === requestedName);
    if (portrait === undefined) throw new Error("TASK_COMPANION_UNKNOWN");
    if (reserved.has(portrait.nickname)) throw new Error("TASK_COMPANION_BUSY");
    reserved.add(portrait.nickname);
    this.conversationLeases.set(conversationKey, reserved);
    let available = true;
    const release = (): void => {
      if (available) {
        available = false;
        reserved.delete(portrait.nickname);
        if (!reserved.size) this.conversationLeases.delete(conversationKey);
      }
    };
    return { nickname: portrait.nickname, assetFileName: portrait.assetFileName, release };
  }
}
export const taskCharacterLeasePool = new TaskCharacterLeasePool();
