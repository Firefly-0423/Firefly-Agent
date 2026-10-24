import TurndownService from "turndown";
import type { ToolContext } from "../registry/tool-context";
import type { ToolDefinition } from "../registry/tool-registry";
import { TtlResultCache } from "./ttl-result-cache";
import { readResponseBytes, withPublicResponse } from "../network-guard";

const LOG_PREFIX = "[BuiltinTools]";
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 512 * 1024;
const FETCH_CACHE_TTL_MS = 30 * 60_000;
const fetchCache = new TtlResultCache<string>(FETCH_CACHE_TTL_MS);
const MAIN_REGION_MIN_TEXT_CHARS = 200;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
const GITHUB_RESERVED_PREFIXES = new Set([
  "topics", "orgs", "users", "settings", "sponsors", "collections", "features", "marketplace", "apps", "gists", "site", "security", "about", "pricing",
  "enterprise", "explore", "trending", "search", "notifications", "dashboard", "new", "pulls", "issues", "watching", "organizations", "codespaces",
]);

export function clearFetchUrlCache(): void { fetchCache.clear(); }

function lastIndexOfTagClose(markup: string, element: string): number {
  const closer = new RegExp(`</${element}\\s*>`, "gi");
  let end = -1;
  for (let match = closer.exec(markup); match !== null; match = closer.exec(markup)) end = match.index + match[0].length;
  return end;
}

function extractMainRegion(markup: string): string | null {
  for (const element of ["article", "main"]) {
    const opener = markup.match(new RegExp(`<${element}\\b[^>]*>`, "i"));
    if (!opener || opener.index === undefined) continue;
    const end = lastIndexOfTagClose(markup, element);
    if (end < 0 || end <= opener.index) continue;
    const candidate = markup.slice(opener.index, end);
    if (candidate.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length >= MAIN_REGION_MIN_TEXT_CHARS) return candidate;
  }
  return null;
}

function stripHtml(markup: string): string {
  const cleaned = markup.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const content = extractMainRegion(cleaned) ?? cleaned;
  try { return turndown.turndown(content).replace(/\n{3,}/g, "\n\n").trim(); }
  catch {
    return content.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
}

type Repository = { owner: string; repo: string };
function matchGithubRepoUrl(address: string): Repository | null {
  let parsed: URL;
  try { parsed = new URL(address); } catch { return null; }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
  const components = parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!components) return null;
  const owner = components[1], repo = components[2];
  if (!owner || !repo) return null;
  return GITHUB_RESERVED_PREFIXES.has(owner.toLowerCase()) ? null : { owner, repo };
}

function formatGithubMeta(data: Record<string, unknown>, identity: Repository): string {
  const output = ["# " + identity.owner + "/" + identity.repo];
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (description) output.push("", "> " + description);
  const details: string[] = [];
  if (typeof data.stargazers_count === "number") details.push("stars: " + data.stargazers_count);
  if (typeof data.forks_count === "number") details.push("forks: " + data.forks_count);
  if (typeof data.language === "string" && data.language) details.push("language: " + data.language);
  if (typeof data.default_branch === "string" && data.default_branch) details.push("默认分支: " + data.default_branch);
  const licensing = data.license as { spdx_id?: string } | null | undefined;
  if (licensing?.spdx_id && licensing.spdx_id !== "NOASSERTION") details.push("license: " + licensing.spdx_id);
  if (details.length > 0) output.push("", details.join(" · "));
  return output.join("\n");
}

async function fetchGithubRepoSummary(identity: Repository, address: string, context?: ToolContext): Promise<string | null> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), FETCH_TIMEOUT_MS);
  const signal = context?.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
  const endpoint = `https://api.github.com/repos/${identity.owner}/${identity.repo}`;
  const headers = { "User-Agent": "Mozilla/5.0 (Firefly Agent) Chrome/120 Safari/537.36", Accept: "application/vnd.github+json" };
  try {
    const [metadata, document] = await Promise.all([
      withPublicResponse(endpoint, { signal, headers }, async (response) =>
        response.ok ? readResponseBytes(response, FETCH_MAX_BYTES, true) : null),
      withPublicResponse(endpoint + "/readme", { signal, headers: { ...headers, Accept: "application/vnd.github.raw" } }, async (response) =>
        response.ok ? readResponseBytes(response, FETCH_MAX_BYTES, true) : null),
    ]);
    if (!document) return null;
    const { bytes, truncated: clipped } = document;
    const markdown = new TextDecoder("utf-8").decode(bytes);
    let heading = "";
    if (metadata && !metadata.truncated) {
      try { heading = formatGithubMeta(JSON.parse(metadata.bytes.toString("utf8")) as Record<string, unknown>, identity) + "\n\n---\n\n"; }
      catch { /* README 可独立展示。 */ }
    }
    const attribution = "URL: " + address + "\n来源: GitHub API（仓库元信息 + README 原文）" +
      (clipped ? "\n[README 已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
    return attribution + heading + markdown.trim();
  } catch { return null; }
  finally { deadline.abort(); clearTimeout(timer); }
}

async function executeFetchUrl(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const address = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(address)) return "[错误] url 必须以 http:// 或 https:// 开头";
  const markdown = input.format === "markdown" || input.format === undefined;
  console.log(LOG_PREFIX, "fetch_url:", address, "format=" + (markdown ? "markdown" : "raw"));
  const identity = address + "|" + (markdown ? "markdown" : "raw");
  const cached = fetchCache.get(identity);
  if (cached) {
    const date = new Date(cached.at).toLocaleString("zh-CN", { hour12: false });
    return "[缓存] 摄取于 " + date + "，30 分钟内直接复用\n\n" + cached.value;
  }
  if (markdown) {
    const repository = matchGithubRepoUrl(address);
    if (repository) {
      console.log(LOG_PREFIX, "fetch_url: GitHub 仓库主页，走官方 API:", address);
      const summary = await fetchGithubRepoSummary(repository, address, context);
      if (summary !== null) { fetchCache.set(identity, summary); return summary; }
      console.log(LOG_PREFIX, "fetch_url: GitHub API 不可用，回退普通抓取:", address);
    }
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), FETCH_TIMEOUT_MS);
  const signal = context?.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
  try {
    return await withPublicResponse(address, {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (Firefly Agent) Chrome/120 Safari/537.36", Accept: "text/html,text/markdown,text/plain,*/*;q=0.8" },
    }, async (response) => {
      if (!response.ok) return "[错误] HTTP " + response.status + " " + response.statusText;
      const mime = response.headers.get("content-type") || "";
      const { bytes, truncated: clipped } = await readResponseBytes(response, FETCH_MAX_BYTES, true);
      let content = new TextDecoder("utf-8").decode(bytes);
      if (markdown && /text\/html|application\/xhtml/i.test(mime)) content = stripHtml(content);
      const heading = "URL: " + address + "\nContent-Type: " + mime + (clipped ? "\n[已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
      const output = heading + content;
      fetchCache.set(identity, output);
      return output;
    });
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    return "[错误] fetch 失败: " + detail;
  } finally { deadline.abort(); clearTimeout(timer); }
}

export const fetchUrlTool: ToolDefinition = {
  "id": "fetch_url",
  "name": "读取网页",
  "description": "下载指定 URL 的网页内容并返回正文。HTML 会先做正文提取（剥掉导航/页头/页脚/侧栏，优先取 article/main 正文区），再转成结构化 markdown（保留标题/列表/代码块/表格），便于阅读。\nGitHub 仓库主页（github.com/所有者/仓库）会走官方 API，直接返回仓库元信息 + README 原文。\n\n何时用：\n- 用户给了明确的网址（https://...），想看内容\n- 用户说'看看这个链接''读一下这个网页'\n- 需要读 GitHub README、MCP 安装文档、API 文档等具体页面\n- web_search 之后拿到链接，想看具体内容\n\n不要用于：\n- 用户只给关键词没给网址 → 用 web_search\n- 用户问'今天有什么新闻' → 用 web_search\n- 本地文件路径 → 用 read_file\n\n结果超过长度预算会被剪枝（保留开头结尾、省略中段），observation 里会附 tool-result:// 引用；需要被剪掉的中段内容时，用 read_tool_result 读取，支持 offset/length 分段或 query 关键词定位。\n\n参数：url (必填，完整 http(s) 地址)，format (可选 markdown|raw，默认 markdown)。",
  "enabled": true,
  "risk": "network",
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "要拉取的完整 URL（必须包含 https:// 或 http://）"
      },
      "format": {
        "type": "string",
        "description": "markdown=自动清洗 HTML 为纯文本（默认）；raw=原文不处理"
      }
    },
    "required": [
      "url"
    ]
  },
  execute: executeFetchUrl,
};
