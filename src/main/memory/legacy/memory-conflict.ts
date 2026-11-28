export type PossibleConflictCandidate = {
  confidence: number
  isCandidate: boolean
  reason?: string
}

/** 矛盾词表：每项是“肯定词”及其对应的“否定词”们，只要两段文本分居两侧就算疑似矛盾 */
const CONTRADICTION_PAIRS: Array<[string, string[]]> = [
  "喜欢=不喜欢,讨厌,反感,厌恶,不再喜欢",
  "爱=不爱,讨厌,恨",
  "想=不想,别想,不愿",
  "要=不要,别要",
  "是=不是,并非",
  "可以=不可以,不行,不能",
  "会=不会",
  "有=没有,没了,无",
  "忙=不忙,闲",
].map((row): [string, string[]] => {
  const [positive, negatives] = row.split("=")
  return [positive, negatives.split(",")]
})

// 这些词本身不构成话题，提取话题词时要跳过
const STOP_TERMS = new Set<string>(
  (
    "用户 一个 一种 这个 那个 自己 因为 所以 但是 没有 不是 不会 不能 不喜 " +
    "喜欢 讨厌 反感 厌恶 不爱 不想 不要 不行 没了 不忙"
  ).split(" "),
)

const PURE_CJK = /^[一-鿿]+$/

function topicTerms(text: string): Set<string> {
  const found = new Set<string>()
  const tokens = text.match(/[一-鿿]{2,}|[a-zA-Z0-9]{3,}/g) ?? []
  tokens.forEach((token) => {
    const word = token.toLowerCase()
    if (STOP_TERMS.has(word)) return
    found.add(word)
    if (word.length <= 2 || !PURE_CJK.test(word)) return
    // 较长的中文词再拆成相邻二字组，提高共同话题的命中率
    for (let start = 0; start + 2 <= word.length; start++) {
      const pair = word.slice(start, start + 2)
      if (!STOP_TERMS.has(pair)) found.add(pair)
    }
  })
  return found
}

function shareTopic(left: string, right: string): boolean {
  const rightTerms = topicTerms(right)
  return Array.from(topicTerms(left)).some((term) => rightTerms.has(term))
}

export function findPossibleConflictCandidate(newContent: string, existingContent: string): PossibleConflictCandidate {
  const none: PossibleConflictCandidate = { isCandidate: false, confidence: 0 }
  if (!shareTopic(newContent, existingContent)) return none

  const lowerNew = newContent.toLowerCase()
  const lowerOld = existingContent.toLowerCase()
  const hit = CONTRADICTION_PAIRS.find(([positive, negatives]) => {
    const anyNegative = (s: string) => negatives.some((n) => s.includes(n))
    return (lowerNew.includes(positive) && anyNegative(lowerOld)) || (lowerOld.includes(positive) && anyNegative(lowerNew))
  })
  if (!hit) return none

  return {
    isCandidate: true,
    reason: `possible shared-topic lexical contradiction: ${hit[0]}`,
    confidence: 0.35,
  }
}
