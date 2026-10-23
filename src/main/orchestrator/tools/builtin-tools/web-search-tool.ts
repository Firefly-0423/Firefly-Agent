import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { TtlResultCache } from "./ttl-result-cache";

type SearchReaders = { engine: (() => string) | null; bocha: (() => string) | null; tavily: (() => string) | null; any: (() => string) | null };
const readers: SearchReaders = { engine: null, bocha: null, tavily: null, any: null };
function readSetting<T>(reader: (() => T) | null): T | undefined { return reader?.(); }
export function setSearchConfig(engineGetter: () => string, bochaKeyGetter: () => string, tavilyKeyGetter: () => string, anySearchKeyGetter: () => string): void {
  readers.engine = engineGetter;
  readers.bocha = bochaKeyGetter;
  readers.tavily = tavilyKeyGetter;
  readers.any = anySearchKeyGetter;
}
interface BochaResult { name: string; url: string; snippet: string; summary?: string; siteName?: string }
interface WebSearchResult { title: string; url: string; snippet: string; source?: string }
interface WebSearchOutput { success: true; query: string; resultCount: number; results: WebSearchResult[] }
const cachedSearches = new TtlResultCache<WebSearchOutput>(30 * 60_000);
export function clearWebSearchCache(): void { cachedSearches.clear(); }
function truncateSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > 500) return normalized.slice(0, 500) + "...";
  return normalized;
}
function searchOutput(query: string, results: WebSearchResult[]): WebSearchOutput {
  return { success: true, query, resultCount: results.length, results };
}
type SearchRequest = { endpoint: string; headers: Record<string, string>; body: string };
async function performSearch<T>(
  makeRequest: () => SearchRequest, signal: AbortSignal | undefined,
  parse: (payload: T) => WebSearchOutput,
): Promise<WebSearchOutput> {
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 20_000);
  const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  try {
    const request = makeRequest();
    const reply = await fetch(request.endpoint, { method: "POST", signal: combined, headers: request.headers, body: request.body });
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    return parse(await reply.json() as T);
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`搜索失败：${detail}`);
  } finally { clearTimeout(deadline); }
}
async function bochaSearch(query: string, key: string, signal?: AbortSignal): Promise<WebSearchOutput> {
  return performSearch<{ webPages?: { value?: BochaResult[] }; data?: { webPages?: { value?: BochaResult[] } } }>(() => ({
    endpoint: "https://api.bochaai.com/v1/web-search",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, count: 8, summary: true }),
  }), signal, payload => {
    const rows = payload.data?.webPages?.value ?? payload.webPages?.value ?? [];
    return searchOutput(query, rows.map(item => ({ title: item.name, url: item.url,
      snippet: truncateSnippet(item.summary || item.snippet || ""), ...(item.siteName ? { source: item.siteName } : {}) })));
  });
}
async function tavilySearch(query: string, key: string, signal?: AbortSignal): Promise<WebSearchOutput> {
  return performSearch<{ answer?: string; results?: Array<{ title: string; url: string; content: string }> }>(() => ({
    endpoint: "https://api.tavily.com/search", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: 8, include_answer: true }),
  }), signal, payload => {
    const rows = payload.results ?? [];
    return searchOutput(query, rows.map(item => ({ title: item.title, url: item.url,
      snippet: truncateSnippet(payload.answer && item.content ? `${payload.answer}\n${item.content}` : item.content || "") })));
  });
}
async function anySearchSearch(query: string, key: string, signal?: AbortSignal): Promise<WebSearchOutput> {
  return performSearch<{ data: { results?: Array<{ title: string; url: string; content: string; snippet: string }> } }>(() => {
    const authorization: Record<string, string> = { "Content-Type": "application/json" };
    if (key) authorization.Authorization = `Bearer ${key}`;
    return { endpoint: "https://api.anysearch.com/v1/search", headers: authorization, body: JSON.stringify({ query, max_results: 8 }) };
  }, signal, payload => {
    const rows = payload.data.results ?? [];
    return searchOutput(query, rows.map(item => ({ title: item.title, url: item.url, snippet: truncateSnippet(item.content || item.snippet || "") })));
  });
}
async function executeWebSearch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const backend = readSetting(readers.engine) ?? "off";
  if (backend === "off") throw new Error("E_SEARCH_NOT_ENABLED");
  const phrase = String(args.query ?? "").trim();
  if (!phrase) throw new Error("E_SEARCH_QUERY_EMPTY");
  const identity = backend + "|" + phrase.replace(/\s+/g, " ");
  const saved = cachedSearches.get(identity);
  if (saved) return JSON.stringify({ ...saved.value, cached: true, cachedAt: new Date(saved.at).toISOString() });
  let response: WebSearchOutput;
  switch (backend) {
    case "bocha": {
      const credential = readSetting(readers.bocha) ?? "";
      if (!credential) throw new Error("E_SEARCH_KEY_MISSING");
      response = await bochaSearch(phrase, credential, ctx?.signal);
      break;
    }
    case "tavily": {
      const credential = readSetting(readers.tavily) ?? "";
      if (!credential) throw new Error("E_SEARCH_KEY_MISSING");
      response = await tavilySearch(phrase, credential, ctx?.signal);
      break;
    }
    case "anySearch": response = await anySearchSearch(phrase, readSetting(readers.any) ?? "", ctx?.signal); break;
    default: throw new Error(`E_SEARCH_ENGINE_NOT_SUPPORTED:${backend}`);
  }
  cachedSearches.set(identity, response);
  return JSON.stringify(response);
}
const HANDLER_web_search = executeWebSearch;
export const webSearchTool: ToolDefinition = {
  "id": "web_search",
  "name": "联网搜索",
  "description": "搜索互联网获取实时信息。返回搜索结果的标题、链接和摘要。\n\n何时用：\n- 用户问'最近有什么新闻''搜一下 xxx 怎么用''xxx 是什么'\n- 用户问的事需要联网才能知道（股价、赛事、最新技术）\n- 用户只给关键词，没给具体网址\n\n不要用于：\n- 用户已经给了明确网址 -> 用 fetch_url\n- 用户问本机文件 -> read_file / list_dir\n- 能凭已有知识直接回答的简单问题\n\n参数：query（必填，搜索关键词）。",
  "enabled": true,
  "risk": "network",
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "搜索关键词"
      }
    },
    "required": [
      "query"
    ]
  }
, execute: HANDLER_web_search };
