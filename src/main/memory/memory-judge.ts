import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, MemoryJudgeTurn } from "./memory-types"
import { invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client"
import { loadMemoryModelConfig } from "./memory-llm-shared"
import { parseMemoryJudgeResult, validateMemoryJudgeBusiness, MemoryJudgeResult } from "./memory-schemas"

// 模型自己写出这些绝对化措辞、而用户原话里没有时，视为过度概括
const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"]

function overclaimsBeyondEvidence(summary: string, quotes: string[]): boolean {
  for (const term of ABSOLUTE_TERMS) {
    if (!summary.includes(term)) continue
    if (!quotes.some((q) => q.includes(term))) return true
  }
  return false
}

/** 业务层过滤：属于 Judge 的业务语义，不是 schema 校验 */
function keepAcceptableCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return candidates.filter((c) => {
    if (c.shouldWrite !== true) return false
    if (c.layer === "L0" && !(c.certainty === "explicit" && c.attribution === "user_explicit")) return false
    if (c.forbiddenOverclaims && c.forbiddenOverclaims.length > 0) return false
    return !overclaimsBeyondEvidence(c.summary ?? c.content, c.evidenceQuotes ?? [])
  })
}

const NOTHING_LOG = "[PMRS/Judge] 本轮无值得记录的信息"

function listL0Fields(): string {
  return Object.entries(L0_FIELD_DESCRIPTIONS)
    .map(([field, description]) => `  · ${field}：${description}`)
    .join("\n")
}

function buildSystemPrompt(): string {
  // 提示词按若干段拼接，段内用 \n 连接；整体输出与逐行书写完全一致
  const segments: string[] = [
    "你是一个保守的记忆候选提取器，不是事实裁判，也不是用户画像改写器。\n你的目标是少记错，不是多记住。\n",
    "你只能提取用户明确表达、且未来确实有帮助的信息候选。\n禁止把推断写成确定事实；禁止把一次性状态写成长期偏好；禁止为了输出而输出。",
    "如果最近这些对话没有值得记的内容，必须返回 {\"candidates\":[]}。\n\nPMRS 层级定义：\n- 画像 (L0)：用户稳定身份信息或核心画像。只有 certainty=explicit 且 attribution=user_explicit 才允许进入画像。",
    "  识别到画像信息时，必须同时在 field 字段里指定要写入哪个格子。\n  可用的 field 值如下（只能用这些，不能自己发明）：",
    listL0Fields(),
    "\n  重要：field 的值必须严格是上方列出的英文字段名，",
    "  例如 preferredName、occupation，\n  不能用 nickname、name、job 等其他词。\n- 近况 (L1)：用户近期目标或阶段性偏好，只能写近期状态，不要写成长期偏好。",
    "  识别到近况信息时，必须在 field 字段指定写入哪个格子，可用值：recentGoals / recentPreferences / currentProject。\n- 片段 (L2)：具体事件、经历、局部偏好、情绪背景、待观察信息。",
    "\n判断原则：\n- 宁可漏记，不要误记\n- 纯日常问候、闲聊、情绪发泄（无信息量）→ 返回 {\"candidates\":[]}",
    "- 必须是用户主动表达的信息，不是 AI 说的\n- summary 必须忠于用户原话和上下文，不要自行推广范围\n- 如果只是 AI 的建议、安慰、总结、推断，不要写成用户事实",
    "- 不要把「这次」「刚刚」「这个话题里」变成长期偏好\n- 不要自动使用绝对化表达：只、永远、从不、一定、完全、绝对、以后都、不再，除非用户原话明确说过这些词",
    "- 如果 summary 中存在可能过度概括的词，必须写入 forbiddenOverclaims；有 forbiddenOverclaims 时 shouldWrite 必须是 false\n\n重要格式规则：",
    "- summary 和 evidenceQuotes 字段的值里，禁止出现英文双引号 \"\n- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
    "- 输出必须是顶层 JSON 对象，顶层字段为 candidates 和 entities\n- candidates 的值必须是 JSON 数组\n\n实体抽取（与候选一起输出，复用本次调用，不额外开销）：",
    "- 只抽用户明确提到的、有指代价值的命名实体（人物名/地名/机构名/具体偏好对象/具体概念）\n- 实体类型只能是：person（人物）/ place（地点）/ concept（概念）/ preference（偏好）/ organization（组织）\n- 禁止抽取聊天碎片：标点、引号、emoji、语气词、单字、代词、感叹词、对话子串",
    "- 如果只是 AI 提到的、或用户随口一带没有指代价值的，不要抽\n- aliases 字段：该实体的其他叫法（可选，没有就省略）",
    "- 没有值得记录的实体时，entities 返回空数组 []\n\nL2 slug 抽取（与候选一起输出，复用本次调用，不额外开销）：",
    "- L2 候选必须输出 slug 字段：精炼的记忆标题，将作为 Obsidian 文件名与双链锚点\n- 规则：≤20 字；只能含中文/英文字母/数字/下划线/连字符；禁止标点、引号、空格、emoji",
    "- slug 应高度概括本条记忆的主题，不要直接复用 summary 全文\n- 示例：用户说喜欢吃香菇 → slug=\"喜欢香菇\"；和小张约下周吃饭 → slug=\"和小张约饭\"；React Chat 窗口迁移 → slug=\"ReactChat迁移\"\n- L0 / L1 候选不要输出 slug 字段\n",
    "L2 sourceQuote 抽取（与候选一起输出，复用本次调用，不额外开销）：\n- L2 候选必须输出 sourceQuote 字段：从最近对话里挑出最有信息量的一段原文片段（用户或对话原话）\n- 目的：L2 是浓缩结论，会丢失字面信息（专有名词/数字/代码片段）；sourceQuote 保留「用户当时说的原话」，召回时让后续模型看到字面证据",
    "- 规则：软上限 500 字；不要整段照抄对话；优先挑含专有名词、数字、代码、关键名词的句子；允许标点、空格、emoji（因为是原文）\n- 不要把 summary 复制进 sourceQuote；sourceQuote 应是原话片段，summary 是你的浓缩结论",
    "- 示例：用户说「我用 React 18.2 做的前端，部署在 vercel 上」→ sourceQuote=\"我用 React 18.2 做的前端，部署在 vercel 上\"\n- L0 / L1 候选不要输出 sourceQuote 字段\n",
    "输出结构：\n{",
    "  \"candidates\": [\n    {\n      \"layer\": \"L0\",\n      \"field\": \"preferredName\",",
    "      \"summary\": \"保守、可追溯的候选摘要\",\n      \"slug\": \"L2精炼标题\",\n      \"sourceQuote\": \"L2原文对话片段\",",
    "      \"content\": \"与 summary 相同\",\n      \"confidence\": 0.9,",
    "      \"triggerText\": \"用户原话短引文\",\n      \"importance\": \"low|medium|high\",\n      \"stability\": \"one_off|situational|stable\",",
    "      \"certainty\": \"explicit|inferred|uncertain\",\n      \"attribution\": \"user_explicit|assistant_inferred|mixed\",",
    "      \"evidenceQuotes\": [\"用户原话短引文，必须来自用户\"],\n      \"contextSummary\": \"最近多轮上下文概括，不超过80字\",\n      \"shouldWrite\": true,\n      \"reason\": \"为什么值得记，或为什么不写\",",
    "      \"forbiddenOverclaims\": []\n    }\n  ],",
    "  \"entities\": [\n    {\"name\": \"小张\", \"type\": \"person\", \"aliases\": [\"张三\"]}",
    "  ]\n}\n",
    "片段不需要 field。近况必须指定 field（recentGoals / recentPreferences / currentProject）。\nL2 片段必须输出 slug 字段（精炼标题，≤20 字，仅中文/字母/数字/_/-），如 \"slug\": \"喜欢香菇\"。",
    "L2 片段必须输出 sourceQuote 字段（原文对话片段，≤500 字，允许标点/空格/emoji），如 \"sourceQuote\": \"我用 React 18.2 做的前端\"。\ninferred / uncertain 不允许进入画像；如果还值得保留，只能放片段，或者 shouldWrite=false。\n没有值得记录的信息时，输出：{\"candidates\":[],\"entities\":[]}\nsummary 和 evidenceQuotes 里禁止出现英文双引号，用「」替代。",
    "实体 name 也禁止包含英文双引号、标点、emoji。\nslug 禁止包含标点、引号、空格、emoji；只能含中文/字母/数字/下划线/连字符。",
  ]
  return segments.join("\n")
}

function buildUserPrompt(turns: MemoryJudgeTurn[], conversationId: string): string {
  const blocks = turns.map((t, i) => `第 ${i + 1} 轮：\n用户：${t.userInput}\nAI：${t.assistantReply}`)
  return `conversationId: ${conversationId}\n最近对话：\n${blocks.join("\n\n")}`
}

function describeCandidate(c: MemoryCandidate): string {
  const text = (c.summary ?? c.content).slice(0, 20)
  const tag = c.layer === "L0" && c.field ? `${c.layer}.${c.field}` : c.layer
  return `${tag}("${text}", ${c.confidence.toFixed(2)})`
}

export class MemoryJudge {
  async judgeRecentTurns(turns: MemoryJudgeTurn[], conversationId: string): Promise<MemoryJudgeResult> {
    console.log(`[PMRS/Judge] 分析最近 ${turns.length} 轮对话...`)
    const nothing = (): MemoryJudgeResult => ({ candidates: [], entities: [] })

    try {
      const config = loadMemoryModelConfig()
      if (!config.apiKey) {
        console.error("[PMRS/Judge] LLM 调用失败: missing api key")
        console.log(NOTHING_LOG)
        return nothing()
      }

      const result = await invokeMemoryStructuredOutput<MemoryJudgeResult>({
        config,
        validateBusiness: validateMemoryJudgeBusiness,
        parseSchema: parseMemoryJudgeResult,
        maxOutputTokens: getDefaultMaxOutputTokens("judge"),
        userPrompt: buildUserPrompt(turns, conversationId),
        systemPrompt: buildSystemPrompt(),
        operation: "judge",
      })

      const accepted = keepAcceptableCandidates(result.candidates)
      // 来源会话 ID 由这里补上，模型不负责输出
      accepted.forEach((c) => {
        c.sourceConversationId = conversationId
      })

      console.log(`[PMRS/Judge] 提取候选: ${accepted.length} 条（过滤后），实体: ${result.entities.length} 个`)
      console.log(`[PMRS/Judge] 候选详情: ${accepted.map(describeCandidate).join(" ")}`)
      return { candidates: accepted, entities: result.entities }
    } catch (error) {
      console.error("[PMRS/Judge] LLM 调用失败:", error)
      console.log(NOTHING_LOG)
      return nothing()
    }
  }

  async judge(userMessage: string, assistantMessage: string, conversationId: string): Promise<MemoryJudgeResult> {
    const turn: MemoryJudgeTurn = { userInput: userMessage, assistantReply: assistantMessage }
    return this.judgeRecentTurns([turn], conversationId)
  }
}

export const memoryJudge = new MemoryJudge()
