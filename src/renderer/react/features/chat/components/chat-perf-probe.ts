export interface ChatPerfProbeCounters {
  markdownRenders: number; navigationRenders: number;
  sidebarRenders: number; listRenders: number;
}

export function reportChatPerfRender(key: keyof ChatPerfProbeCounters): void {
  // 普通页面不注册探针。
  if (typeof window !== "undefined") {
    const scope = window as typeof window & { __fireflyChatPerfProbe?: ChatPerfProbeCounters };
    const target = scope.__fireflyChatPerfProbe;
    if (target && typeof target[key] === "number") { target[key] += 1; }
  }
}
