import type { ChatMessage, ChatSession, ChatSessionMeta, ReasoningBlock, RunActivityRecord, ToolExecutionRecord } from "../../shared/chat-types";
import type { AguiEvent } from "../react/features/chat/pages/chat-page-bridge";
export type PerfDataset = "plain" | "markdown" | "mixed";
export interface PerfFixtureOptions { seed: number; count: number; dataset: PerfDataset; }
export interface StreamingScriptOptions { durationMs: number; seed: number; dataset: PerfDataset; }
export interface ScriptedEvent { event: AguiEvent; atMs: number; }
export interface StreamingScript { streamLength: number; deltaCount: number; events: ScriptedEvent[]; }
type TerminalAguiEvent = AguiEvent & { result?: { status?: string } };
export function runFinishedEvent(runId: string, status: string): AguiEvent {
  const terminal: TerminalAguiEvent = { type: "RUN_FINISHED", runId, result: { status } };
  return terminal;
}
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) | 0;
    let bits = Math.imul(state ^ (state >>> 15), 1 | state);
    bits = (bits + Math.imul(bits ^ (bits >>> 7), 61 | bits)) ^ bits;
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  };
}
function choose<T>(random: () => number, choices: readonly T[]): T {
  return choices[Math.floor(random() * choices.length)]!;
}
const userSamples = [
  "帮我把这段代码里的循环改写成更高效的写法",
  "今天下午三点提醒我参加项目评审会议",
  "最近总感觉注意力不集中，有什么改善的方法吗",
  "帮我看一下这个报错是什么意思：TypeError: cannot read property of undefined",
  "给我推荐几本关于系统设计的书，最好有中文版",
  "这个函数的时间复杂度能优化到线性吗？现在循环套循环太慢了",
  "帮我总结一下今天会议里提到的三个待办事项",
  "为什么我的打包体积突然变大了？上个月还是两兆",
  "写一首关于秋天傍晚的小诗，四句就行",
  "解释一下 React 里 useMemo 的依赖数组机制"
];
const plainSamples = [
  "好的，这个问题可以从两个层面来看。首先是整体结构：把重复计算的部分提取出来，避免在循环内部反复执行相同的操作。其次是数据结构的选择：如果查找是热点路径，用哈希表替换数组遍历通常能把复杂度从线性降到常数。\n\n不过也要注意权衡，数据量小的时候哈希表的开销可能反而更高，建议先用真实数据量做一次对比测试再决定。",
  "可以从这几个方面入手：一是保证规律的作息，睡眠不足会直接影响工作记忆；二是把大任务拆成小块，每块控制在二十五分钟左右，中间安排短暂休息；三是减少上下文切换，同一时间只处理一件事，切换的成本比想象中高很多。\n\n如果长期如此且影响生活，也可以考虑咨询专业人士的意见。",
  "这个报错说明你在访问一个对象的属性之前，对象本身是 undefined。常见原因有三种：异步数据还没返回就开始取值、函数参数漏传、或者数据结构和你以为的不一样。\n\n建议先在取值前打印一下变量本身，确认它到底在哪一步变成了 undefined，再决定是加空值保护还是修正调用顺序。",
  "时间复杂度优化到线性是可行的，关键在于消除内层循环的重复扫描。当前写法里每次都要从头找一遍，但其实可以维护一个哈希映射，把已经见过的元素记下来，整体只扫一遍就能出结果。\n\n代价是多了一份辅助空间，空间复杂度从常数变成线性，属于典型的空间换时间。"
];
const markdownSamples = [
  "## 问题分析\n\n当前实现的瓶颈在于**每次渲染都全量重建列表**，可以从三个方向入手：\n\n1. 减少不必要的重渲染（引用稳定化）\n2. 把全量计算拆成单条缓存\n3. 必要时再考虑虚拟化\n\n### 示例代码\n\n```ts\ninterface CacheEntry<T> {\n  value: T;\n  expiresAt: number;\n}\n\nexport function createMemoCache<T>(ttlMs: number) {\n  const store = new Map<string, CacheEntry<T>>();\n  return {\n    get(key: string): T | undefined {\n      const entry = store.get(key);\n      if (!entry) return undefined;\n      if (entry.expiresAt < Date.now()) {\n        store.delete(key);\n        return undefined;\n      }\n      return entry.value;\n    },\n    set(key: string, value: T) {\n      store.set(key, { value, expiresAt: Date.now() + ttlMs });\n    },\n  };\n}\n```\n\n> 注意：缓存失效规则要保持单一，不要同时维护版本号和整体替换两套机制。\n\n### 复杂度对比\n\n| 方案 | 时间复杂度 | 空间复杂度 | 备注 |\n| --- | --- | --- | --- |\n| 全量重建 | O(n) | O(1) | 基线 |\n| 单条缓存 | O(1) 均摊 | O(n) | 空间换时间 |\n\n相关阅读可以参考 [React 官方文档](https://react.dev) 里关于 `useMemo` 的章节。",
  "## 实现思路\n\n分治策略的核心是**把大问题拆成同构的小问题**，拆到可以直接求解的粒度再逐层合并。\n\n### Python 版本\n\n```python\ndef merge_intervals(intervals: list[list[int]]) -> list[list[int]]:\n    if not intervals:\n        return []\n    intervals.sort(key=lambda item: item[0])\n    merged = [intervals[0]]\n    for start, end in intervals[1:]:\n        last = merged[-1]\n        if start <= last[1]:\n            last[1] = max(last[1], end)\n        else:\n            merged.append([start, end])\n    return merged\n```\n\n### 边界情况\n\n- 空输入直接返回\n- 只有一个区间时无需合并\n- 区间已经是排好序的（可省略排序步骤）\n\n数学上可以证明合并后的区间两两不相交：假设 $A=[a_1, b_1]$ 与 $B=[a_2, b_2]$ 且 $a_2 \\le b_1$，则合并结果 $[a_1, \\max(b_1, b_2)]$ 覆盖了两者的并集。",
  "## 排查步骤\n\n遇到构建体积异常时按下面的顺序排查，通常能快速定位：\n\n1. 先对比两次构建的产物清单，找出增量最大的 chunk\n2. 确认是否新引入了大体积依赖（图标库、图表库最常见）\n3. 检查 tree-shaking 是否生效：`import { Button } from \"lib\"` 优于 `import lib from \"lib\"`\n\n```ts\n// 按需引入：只打包用到的部分\nimport { debounce } from \"lodash-es\";\n\n// 全量引入：整个库都会进 bundle\nimport _ from \"lodash\";\n```\n\n### 常见误判\n\n> 体积变大不一定是代码变多，source map 文件、重复打包的多版本依赖也会撑大产物目录。"
];
const reasoningSamples = [
  "用户问的是性能优化方向，先分析现有结构找出热点，再决定是缓存还是虚拟化。历史消息每次全量重建确实可疑，但要用数据说话。",
  "这个报错信息指向空值访问，需要先确认数据流：异步返回前取值、参数漏传、结构不匹配，三种情况的处理方式各不相同。",
  "先理清需求边界：数据量多大、更新频率多高、是否需要动画。如果列表几百条以内，先做引用稳定化可能比虚拟化收益更大。"
];
const toolNames = [
  "web_search",
  "read_file",
  "write_file",
  "run_command",
  "fetch_url"
];

function toolResultText(tool: string): string {
  switch (tool) {
    case "web_search": return JSON.stringify({ results: [{ title: "示例结果", snippet: "相关内容摘录", url: "https://example.com" }] });
    case "read_file": case "write_file": return JSON.stringify({ ok: true, path: "src/example.ts", lines: 42 });
    default: return JSON.stringify({ ok: true, exitCode: 0, durationMs: 320 });
  }
}
function plainAnswer(random: () => number): string { return choose(random, plainSamples); }
function markdownAnswer(random: () => number): string { return choose(random, markdownSamples); }
function buildUserMessage(id: string, at: number, random: () => number): ChatMessage {
  return { id, role: "user", content: choose(random, userSamples), at };
}
function buildAssistantMessage(id: string, at: number, random: () => number, dataset: PerfDataset, index: number): ChatMessage {
  if (dataset === "plain" || dataset === "markdown") {
    return { id, role: "model", content: dataset === "plain" ? plainAnswer(random) : markdownAnswer(random), at };
  }
  const quantity = 1 + Math.floor(random() * 3);
  const executions: ToolExecutionRecord[] = [];
  for (let ordinal = 0; ordinal < quantity; ordinal += 1) {
    const tool = toolNames[(index + ordinal) % toolNames.length]!;
    executions.push({
      id: `${id}-tool-${ordinal}`,
      name: tool,
      displayName: tool === "web_search" ? "网页搜索" : tool === "read_file" ? "读取文件" : tool === "write_file" ? "写入文件" : tool === "run_command" ? "执行命令" : "抓取网页",
      status: "success",
      result: toolResultText(tool),
      argsText: JSON.stringify({ query: "性能优化" }),
      seq: ordinal,
    });
  }
  const thoughts: ReasoningBlock[] = [{ id: `${id}-reasoning`, content: choose(random, reasoningSamples), seq: quantity }];
  const response: ChatMessage = {
    id,
    role: "model",
    content: plainAnswer(random),
    reasoningBlocks: thoughts,
    toolExecutions: executions,
    at,
  };
  if (index % 2 === 0) {
    const activity: RunActivityRecord = { startedAt: at, completedAt: at + 4200, reasoningMs: 1800 };
    response.runActivity = activity;
  }
  return response;
}
export function buildPerfSession(options: PerfFixtureOptions): ChatSession {
  const { dataset: kind, count: historyCount, seed: randomSeed } = options;
  const random = mulberry32(randomSeed);
  const timestamp = Date.now();
  const history: ChatMessage[] = [];
  for (let ordinal = 0; ordinal < historyCount; ordinal += 1) {
    const sentAt = timestamp - (historyCount - ordinal) * 60_000;
    const messageId = `perf-m-${ordinal}`;
    history.push(ordinal % 2 === 0 ? buildUserMessage(messageId, sentAt, random) : buildAssistantMessage(messageId, sentAt, random, kind, ordinal));
  }
  return {
    id: "perf-session",
    title: "性能基线会话",
    identityId: null,
    messages: history,
    createdAt: timestamp - (historyCount + 10) * 60_000,
    updatedAt: timestamp - 60_000,
    schemaVersion: 1,
    mode: "chat",
  };
}
export function perfSessionMeta(session: ChatSession): ChatSessionMeta {
  const metadata: ChatSessionMeta = {
    id: session.id, title: session.title, identityId: session.identityId,
    createdAt: session.createdAt, updatedAt: session.updatedAt,
    messageCount: session.messages.length, mode: "chat",
  };
  return metadata;
}
function sliceDeltas(text: string, random: () => number, min: number, max: number): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length;) {
    const width = min + Math.floor(random() * (max - min + 1));
    chunks.push(codePoints.slice(offset, offset + width).join(""));
    offset += width;
  }
  return chunks;
}
function buildStreamTarget(dataset: PerfDataset, random: () => number, minLength: number): string {
  const paragraphs: string[] = [];
  let size = 0;
  let attempts = 0;
  while (size < minLength) {
    paragraphs.push(dataset === "plain" ? plainAnswer(random) : markdownAnswer(random));
    size = paragraphs.join("\n\n").length;
    attempts += 1;
    if (attempts > 50) break;
  }
  return paragraphs.join("\n\n");
}
export function buildStreamingScript(options: StreamingScriptOptions): StreamingScript {
  const { dataset: kind, seed: randomSeed, durationMs: playTime } = options;
  const random = mulberry32(randomSeed + 9999);
  const schedule: ScriptedEvent[] = [];
  const runId = "perf-run-1";
  const record = (atMs: number, event: AguiEvent): void => { schedule.push({ atMs, event }); };
  record(0, { type: "RUN_STARTED", runId });
  let clock = 240;
  if (kind === "mixed") {
    const thought = `${choose(random, reasoningSamples)}${choose(random, reasoningSamples)}`;
    const chunks = sliceDeltas(thought, random, 16, 48);
    record(clock, { type: "REASONING_MESSAGE_START", runId, messageId: "perf-reasoning-1" });
    clock += 60;
    for (const fragment of chunks) {
      record(clock, { type: "REASONING_MESSAGE_CONTENT", runId, messageId: "perf-reasoning-1", delta: fragment });
      clock += 55;
    }
    record(clock, { type: "REASONING_MESSAGE_END", runId, messageId: "perf-reasoning-1" });
    clock += 120;
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      const tool = toolNames[ordinal % toolNames.length]!;
      const callId = `perf-tool-${ordinal}`;
      record(clock, { type: "TOOL_CALL_START", runId, toolCallId: callId, toolCallName: tool, toolCallDisplayName: tool === "web_search" ? "网页搜索" : "读取文件" });
      clock += 90;
      for (const fragment of sliceDeltas('{"query":"性能优化 baseline"}', random, 6, 16)) {
        record(clock, { type: "TOOL_CALL_ARGS", runId, toolCallId: callId, delta: fragment });
        clock += 40;
      }
      clock += 260;
      record(clock, { type: "TOOL_CALL_RESULT", runId, toolCallId: callId, status: "success", content: toolResultText(tool) });
      clock += 60;
      record(clock, { type: "TOOL_CALL_END", runId, toolCallId: callId });
      clock += 140;
    }
  }
  const begins = clock + 120;
  const budget = Math.max(2000, playTime - begins - 400);
  const requestedSize = Math.ceil((budget / 32) * 20);
  const response = buildStreamTarget(kind, random, requestedSize);
  const fragments = sliceDeltas(response, random, 8, 32);
  record(begins, { type: "TEXT_MESSAGE_START", runId, messageId: "perf-stream-msg" });
  let nextTime = begins + 40;
  let emitted = 0;
  for (const fragment of fragments) {
    if (nextTime > begins + budget) break;
    record(nextTime, { type: "TEXT_MESSAGE_CONTENT", runId, messageId: "perf-stream-msg", delta: fragment });
    nextTime += 32;
    emitted += 1;
  }
  const ends = nextTime + 120;
  record(ends, { type: "TEXT_MESSAGE_END", runId, messageId: "perf-stream-msg" });
  record(ends + 160, runFinishedEvent(runId, "success"));
  return { events: schedule, deltaCount: emitted, streamLength: response.length };
}
