const MAX_RECENT_INJECTIONS = 20
const RECENT_INJECTION_TTL_MS = 10 * 60 * 1000

type RecentInjection = { injectedAt: number; l2Id: string }

type SearchEntryWithMetadata = { metadata?: Record<string, unknown>; text: string }

// 最近注入过的 L2 记忆，按需淘汰：先去掉过期项，再只保留最新的若干条
let recentInjections: RecentInjection[] = []

function prune(now: number): void {
  const oldest = now - RECENT_INJECTION_TTL_MS
  const alive = recentInjections.filter((item) => !(item.injectedAt < oldest))
  alive.sort((a, b) => b.injectedAt - a.injectedAt)
  recentInjections = alive.slice(0, MAX_RECENT_INJECTIONS)
}

export function clearRecentMemoryInjections(): void {
  recentInjections = []
}

export function recordRecentMemoryInjection(l2Ids: string[], now = Date.now()): void {
  l2Ids.forEach((l2Id) => {
    const hit = recentInjections.find((item) => item.l2Id === l2Id)
    if (hit) {
      hit.injectedAt = now
      return
    }
    recentInjections.push({ l2Id, injectedAt: now })
  })
  prune(now)
}

export function recordRecentMemorySearchEntries(entries: SearchEntryWithMetadata[], now = Date.now()): void {
  const unique = new Set<string>()
  for (const entry of entries) {
    const id = entry.metadata?.l2Id
    if (typeof id === "string" && id.length > 0) unique.add(id)
  }
  recordRecentMemoryInjection(Array.from(unique), now)
}

export function getRecentlyInjectedMemoryIds(now = Date.now()): string[] {
  prune(now)
  return [...recentInjections].sort((a, b) => a.injectedAt - b.injectedAt).map((item) => item.l2Id)
}

export function wasRecentlyInjectedMemory(l2Id: string, now = Date.now()): boolean {
  prune(now)
  return recentInjections.some((item) => item.l2Id === l2Id)
}
