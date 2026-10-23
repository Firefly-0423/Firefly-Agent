import { updateWorldbookActivation, getPermanentWorldbookEntries, getActiveWorldbookEntries, getCascadeWorldbookEntries, searchMemory, INJECTION_HEADER, INJECTION_PREAMBLE } from "../rag";
import { memoryStore } from "../memory/memory-store";
import { entityGraph } from "../memory/entity-graph";
import { recordRecentMemoryInjection } from "../memory/recent-injected-memory";
import { l2DmaeManager } from "../memory/l2-dmae-manager";
import { toolRegistry } from "./tools/registry/tool-registry";
export { ToolCallResult } from "./types";
export { scheduleMemoryWrite } from "./context-builder";
export { buildToneInjection } from "./tone-injector";

function isDimensionMismatchError(err: unknown): boolean { return err instanceof Error && /dimension mismatch/i.test(err.message); }

export async function buildMemoryInjection(userInput: string): Promise<string> {
  const sections: string[] = [];
  try {
    const records = await memoryStore.getAllL2();
    const activated = await l2DmaeManager.getActiveL2ForPrompt(records, 4);
    recordRecentMemoryInjection(activated.map((memory) => memory.id));
    if (activated.length > 0) {
      const lines = activated.map((memory) => {
        const source = memory.sourceQuote ?? memory.triggerText;
        const conflict = !!(memory.conflictWith && memory.conflictWith.length > 0);
        const caution = conflict ? " ⚠️（该信息可能存在矛盾记录）" : "";
        const quote = source ? `（原文：${source}）` : "";
        return `· ${memory.content}${caution}${quote}`;
      });
      sections.push("【相关记忆】\n" + lines.join("\n"));
    }
  } catch (failure) {
    if (isDimensionMismatchError(failure)) {
      console.error("[Orchestrator] user_memory search blocked: embedding dimension mismatch. Index rebuild required.", failure);
      sections.push("【记忆系统】\n⚠️ 向量索引维度不一致，记忆检索已暂停。请在设置中切换 Embedding 模型以重建索引。");
    } else console.warn("[Orchestrator] L2 DMAE injection failed:", failure);
  }
  try {
    const passages = await searchMemory(userInput, "imported_doc", 2);
    if (passages.length > 0) sections.push("【相关文档】\n" + passages.map((passage) => "· " + passage).join("\n"));
  } catch (failure) {
    if (isDimensionMismatchError(failure)) {
      console.error("[Orchestrator] imported_doc search blocked: embedding dimension mismatch. Index rebuild required.", failure);
      sections.push("【文档检索】\n⚠️ 向量索引维度不一致，文档检索已暂停。请在设置中切换 Embedding 模型以重建索引。");
    } else console.warn("[Orchestrator] imported_doc search failed:", failure);
  }
  try {
    const relations = entityGraph.search(userInput);
    if (relations) sections.push("【人物关系】\n" + relations);
  } catch (failure) { console.warn("[Orchestrator] entity graph search failed:", failure); }
  return sections.join("\n\n");
}

function getWorldbookTriggerText(userInput: string): string {
  const markers = ["【本轮文件】", "【文档内容】", "【图片视觉信息】", "【图片附件】"];
  const offsets = markers.map((marker) => userInput.indexOf(marker)).filter((offset) => offset >= 0).sort((a, b) => a - b);
  const offset = offsets[0];
  return (typeof offset === "number" ? userInput.slice(0, offset) : userInput).trim();
}

export async function buildWorldbookContext(userInput: string, recentMessages: ReadonlyArray<{ role: string; content?: string }>): Promise<string> {
  const sections: string[] = [];
  try {
    const permanent = getPermanentWorldbookEntries();
    if (permanent.length > 0) sections.push("【常驻背景】\n" + permanent.join("\n\n"));
    const previous = recentMessages.filter((entry) => entry.role === "assistant").slice(-1)[0]?.content ?? "";
    updateWorldbookActivation(getWorldbookTriggerText(userInput), previous);
    const activated = getActiveWorldbookEntries();
    const cascading = getCascadeWorldbookEntries();
    if (activated.length > 0 || cascading.length > 0) {
      const blocks: string[] = [];
      if (activated.length > 0) blocks.push(activated.join("\n\n"));
      if (cascading.length > 0) blocks.push(cascading.join("\n\n"));
      sections.push(INJECTION_HEADER + "\n" + INJECTION_PREAMBLE + "\n\n" + blocks.join("\n\n"));
    }
  } catch (failure) { console.warn("[Orchestrator] worldbook dmae failed:", failure); }
  return sections.join("\n\n");
}

export async function buildAlwaysOnContext(userInput: string, recentMessages: Array<{ role: string; content: string }>): Promise<string> {
  const background = await buildWorldbookContext(userInput, recentMessages);
  const sections: string[] = background ? [background] : [];
  try {
    const permanent = await memoryStore.getL0();
    const current = await memoryStore.getL1();
    const profile = [permanent.preferredName && `称呼：${permanent.preferredName}`, permanent.occupation && `职业：${permanent.occupation}`,
      permanent.longTermInterests && `长期兴趣：${permanent.longTermInterests}`, permanent.language && `常用语言：${permanent.language}`,
      permanent.permanentNote && `备注：${permanent.permanentNote}`].filter(Boolean);
    const recent = [current.recentGoals && `最近目标：${current.recentGoals}`, current.recentPreferences && `近期偏好：${current.recentPreferences}`,
      current.currentProject && `当前项目：${current.currentProject}`].filter(Boolean);
    if (profile.length > 0 || recent.length > 0) {
      let context = "";
      if (profile.length > 0) context += `[用户画像]\n${profile.join("\n")}\n\n`;
      if (recent.length > 0) context += `[近期状态]\n${recent.join("\n")}\n\n`;
      sections.push(context.trim());
    }
  } catch (failure) { console.warn("[Orchestrator] memory load failed:", failure); }
  const enabled = toolRegistry.getEnabledTools();
  console.log("[Orchestrator] Always-on context built, enabled tools: " + enabled.map((entry) => entry.id).join(", "));
  return sections.join("\n\n");
}
