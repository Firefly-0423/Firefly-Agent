// 片段压缩与画像回顾。
//
// 每累计 20 轮由调度器触发一次，先回顾（B），再压缩（A）：
//   A. 把向量相近的 L2 片段聚成组，每组让模型写成一条总结
//   B. 对照当前 L0/L1 画像，让模型给出更新建议

import { memoryStore } from "./memory-store";
import type { L0WritableField } from "./memory-store";
import { addL2MemoryVector, deleteUserMemoryVectors, getEntriesBySource } from "../rag/index";
import { cosineSimilarity } from "../rag/vectorstore";
import { L0_FIELD_DESCRIPTIONS } from "./memory-types";
import type { L2Memory } from "./memory-types";
import { resolveL1Field } from "./memory-manager";
import { commitMemoryCompression } from "./memory-compression-transaction";
import type { CompressionTransactionDeps } from "./memory-compression-transaction";
import { invokeMemoryLlm, invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client";
import { parseMemoryReflectionResult, validateMemoryReflectionBusiness } from "./memory-schemas";
import type { MemoryReflectionItem } from "./memory-schemas";

const SIMILARITY_THRESHOLD = 0.85;
const MIN_GROUP_SIZE = 3;

type VectorizedMemory = {
  embedding: number[];
  l2: L2Memory;
};

/** 按相似度贪心分组：以尚未归组的条目为种子，吸收所有与种子相似的条目 */
function clusterBySimilarity(candidates: L2Memory[]): VectorizedMemory[][] {
  const vectorByRagId = new Map<string, number[]>();
  for (const entry of getEntriesBySource("user_memory")) {
    if (!vectorByRagId.has(entry.id)) vectorByRagId.set(entry.id, entry.embedding);
  }
  const vectorOf = (m: L2Memory): number[] | undefined => vectorByRagId.get(m.ragId as string);

  const taken = new Set<string>();
  const clusters: VectorizedMemory[][] = [];

  for (const seed of candidates) {
    if (taken.has(seed.id)) continue;
    const seedVector = vectorOf(seed);
    if (!seedVector) continue;

    taken.add(seed.id);
    const cluster: VectorizedMemory[] = [{ l2: seed, embedding: seedVector }];
    for (const peer of candidates) {
      if (taken.has(peer.id)) continue;
      const peerVector = vectorOf(peer);
      if (!peerVector) continue;
      if (cosineSimilarity(seedVector, peerVector) >= SIMILARITY_THRESHOLD) {
        cluster.push({ l2: peer, embedding: peerVector });
        taken.add(peer.id);
      }
    }
    if (cluster.length >= MIN_GROUP_SIZE) clusters.push(cluster);
  }
  return clusters;
}

const SUMMARY_RULES = ["保留所有关键信息，去重", "用中文自然语言", "控制在 100 字以内", "直接输出总结文本，不要额外解释"];

function buildSummaryPrompt(lines: string[]): string {
  const head = "你是一个记忆总结助手。以下是一组相似的用户记忆条目，请将它们合并成一条简洁的总结。";
  const rules = SUMMARY_RULES.map((rule) => `- ${rule}`);
  return [head, "要求：", ...rules, "", "记忆条目：", ...lines].join("\n");
}

/** 压缩失败时把来源记忆恢复成压缩之前的状态（按状态分批） */
async function restoreSourceStatuses(sources: Array<{ id: string; status: L2Memory["status"] }>): Promise<void> {
  const idsByStatus = new Map<L2Memory["status"], string[]>();
  sources.forEach(({ id, status }) => {
    const bucket = idsByStatus.get(status);
    if (bucket) bucket.push(id);
    else idsByStatus.set(status, [id]);
  });
  for (const [status, ids] of idsByStatus) {
    await memoryStore.updateL2Status(ids, status);
  }
}

/** 压缩事务落到 memoryStore / 向量库上的具体实现 */
const compressionDeps = (): CompressionTransactionDeps => ({
  warn: (message, error) => console.warn(`[PMRS/Compressor] ${message}:`, error),
  deleteVectors: (ids) => deleteUserMemoryVectors(ids),
  deleteSummary: (id) => memoryStore.deleteL2(id),
  deactivateSummary: (id) => memoryStore.updateL2Status([id], "archived"),
  restoreSources: restoreSourceStatuses,
  archiveSources: (ids) => memoryStore.archiveL2Batch(ids),
  markSummarySynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
  addSummaryVector: addL2MemoryVector,
  createSummary: (input) => memoryStore.addL2Memory(input),
});

async function compressMemories(): Promise<number> {
  const all = await memoryStore.getAllL2();
  const candidates = all.filter((m) => m.status === "active" && !m.isSummary && m.ragId);

  if (candidates.length < MIN_GROUP_SIZE) {
    console.log("[PMRS/Compressor] 活跃 L2 条目不足，跳过压缩");
    return 0;
  }

  const clusters = clusterBySimilarity(candidates);
  if (clusters.length === 0) {
    console.log("[PMRS/Compressor] 无需压缩的组");
    return 0;
  }

  let compressed = 0;
  for (const cluster of clusters) {
    try {
      const lines = cluster.map(({ l2 }) => `- ${l2.content}`);
      const reply = await invokeMemoryLlm({
        operation: "compress",
        messages: [
          { role: "system", content: "你是一个简洁的记忆总结助手。" },
          { role: "user", content: buildSummaryPrompt(lines) },
        ],
        maxOutputTokens: 300,
      });

      const summary = reply.text.replace(/^["「『]|["」』]$/g, "").trim();
      if (!summary || summary.length < 5) continue;

      const first = cluster[0].l2;
      const transactionInput = {
        sources: cluster.map(({ l2 }) => ({ id: l2.id, ragId: l2.ragId, status: l2.status })),
        sourceConversationId: first.sourceConversationId,
        triggerText: first.triggerText,
        content: summary,
      };
      await commitMemoryCompression(transactionInput, compressionDeps());

      await memoryStore.appendReflectionLog({
        type: "compression",
        summary: `压缩 ${cluster.length} 条记忆为一条总结`,
        details: `原条目：${lines.join(" | ")}\n总结：${summary}`,
      });

      compressed += cluster.length;
      console.log(`[PMRS/Compressor] 压缩了 ${cluster.length} 条 → "${summary.slice(0, 40)}"`);
    } catch (err) {
      console.warn("[PMRS/Compressor] 组压缩失败:", err);
    }
  }

  return compressed;
}

const REFLECTION_SYSTEM_PROMPT = [
  "你是一个谨慎的用户画像反思助手。\n你只能输出 JSON，不要 Markdown 代码块、不要解释、不要注释。",
  "输出必须是顶层 JSON 对象，唯一的顶层字段为 updates。\nupdates 是 JSON 数组，每个元素格式：",
  '{ "layer": "L0" 或 "L1", "field": "字段名（可选）", "content": "新的用户画像内容", "confidence": 0.0 到 1.0 }\n没有更新时输出 {"updates":[]}。',
].join("\n");

type L0Snapshot = Awaited<ReturnType<typeof memoryStore.getL0>>;
type L1Snapshot = Awaited<ReturnType<typeof memoryStore.getL1>>;

function describeProfile(l0: L0Snapshot, l1: L1Snapshot): string {
  const rows: Array<string | false> = [
    "当前用户画像：",
    !!l0.preferredName && `  称呼：${l0.preferredName}`,
    !!l0.occupation && `  职业：${l0.occupation}`,
    !!l0.longTermInterests && `  长期兴趣：${l0.longTermInterests}`,
    !!l0.language && `  常用语言：${l0.language}`,
    !!l0.permanentNote && `  备注：${l0.permanentNote}`,
    "",
    "当前近期状态：",
    !!l1.recentGoals && `  最近目标：${l1.recentGoals}`,
    !!l1.recentPreferences && `  近期偏好：${l1.recentPreferences}`,
    !!l1.currentProject && `  当前项目：${l1.currentProject}`,
    `  对话轮数：${l1.roundCount}`,
  ];
  // 分隔用的空串也会被滤掉，结果与逐行 filter(Boolean) 一致
  return rows.filter(Boolean).join("\n");
}

function buildReflectionPrompt(profileText: string): string {
  const fieldList = Object.entries(L0_FIELD_DESCRIPTIONS)
    .map(([field, desc]) => `  ${field}：${desc}`)
    .join("\n");
  const exampleBlock = [
    "输出格式：\n{",
    '  "updates": [\n    { "layer": "L1", "field": "recentGoals", "content": "想系统性学习 Transformer", "confidence": 0.85 }',
    "  ]\n}",
  ];
  return [
    "回顾与用户的长期互动，判断是否需要更新用户画像或近期状态。",
    "",
    profileText,
    "",
    "请分析：",
    "1. 是否有信息可以更新画像字段（稳定身份信息）？",
    `   可用字段：\n${fieldList}`,
    "2. 是否有信息可以更新近况字段（近期目标/偏好/项目）？",
    "",
    ...exampleBlock,
    "",
    "近况字段可以选择 recentGoals / recentPreferences / currentProject。\n如果没有需要更新的信息，输出 {\"updates\":[]}。",
    "只输出 JSON，不要额外解释。",
  ].join("\n");
}

async function runReflection(): Promise<void> {
  try {
    const l0 = await memoryStore.getL0();
    const l1 = await memoryStore.getL1();

    if (l0.isPinned) {
      console.log("[PMRS/Recap] L0 已锁定，跳过更新建议");
    }

    const userPrompt = buildReflectionPrompt(describeProfile(l0, l1));
    const items = await invokeMemoryStructuredOutput<MemoryReflectionItem[]>({
      validateBusiness: validateMemoryReflectionBusiness,
      parseSchema: parseMemoryReflectionResult,
      maxOutputTokens: getDefaultMaxOutputTokens("reflect"),
      userPrompt,
      systemPrompt: REFLECTION_SYSTEM_PROMPT,
      operation: "reflect",
    });

    if (items.length === 0) {
      console.log("[PMRS/Recap] 无 L0/L1 更新建议");
      return;
    }

    const writableL0 = Object.keys(L0_FIELD_DESCRIPTIONS);
    let applied = 0;

    for (const item of items) {
      if (!item.content || !item.confidence || item.confidence < 0.6) continue;
      const preview = item.content.slice(0, 30);

      if (item.layer === "L0" && item.field && writableL0.includes(item.field) && !l0.isPinned) {
        await memoryStore.upsertL0Field(item.field as L0WritableField, item.content.trim());
        await memoryStore.appendReflectionLog({
          type: "l0_update",
          summary: `L0.${item.field} 更新为 "${preview}"（置信度 ${item.confidence.toFixed(2)}）`,
        });
        applied++;
        console.log(`[PMRS/Recap] L0.${item.field} 更新: "${preview}"`);
      } else if (item.layer === "L1") {
        const target = resolveL1Field(item.field, item.content);
        await memoryStore.replaceL1Field(target, item.content.trim());
        await memoryStore.appendReflectionLog({
          type: "l1_update",
          summary: `L1.${target} 更新为 "${preview}"（置信度 ${item.confidence.toFixed(2)}）`,
        });
        applied++;
        console.log(`[PMRS/Recap] L1.${target} 更新: "${preview}"`);
      }
    }

    console.log(`[PMRS/Recap] 完成，更新了 ${applied} 个字段`);
  } catch (err) {
    console.warn("[PMRS/Recap] 执行失败:", err);
  }
}

/** 先回顾再压缩，由调度器在每 20 轮时调用 */
export const runMemoryCompression = async (): Promise<void> => {
  console.log("[PMRS/Compressor] 达到 20 轮，触发回顾 + 片段压缩");
  await runReflection();
  await compressMemories();
};

/** @deprecated Use runMemoryCompression instead. */
export const runReflectionAndCompression = runMemoryCompression;
