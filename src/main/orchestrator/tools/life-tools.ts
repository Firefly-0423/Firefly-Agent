import { beginWriteBatch } from "./registry/file-write-evidence";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { buildReplacedDiff, countLines, finalizeFileChanges } from "./registry/tool-evidence";
import { applyStrReplaceEdits } from "./str-replace-core";
import { currentUserTimezone } from "./built-in-tools";
import { resolveTimeoutPolicy } from "../../runtime-policy";
import { getDateLocale } from "../../startup/locale-context";
import { logger, LogTag } from "../../logging/logger";
import { reviewTrackerFor } from "../review/review-tracker-access";
import { TtlResultCache } from "./builtin-tools/ttl-result-cache";
import { assertWorkspacePathFallback } from "./workspace-boundary";
import { withWorkspaceWrite, type WorkspaceSnapshot, type WorkspaceWriteLease } from "./workspace-handle";

type ToolArguments = Record<string, unknown>;
interface ExpenseRecord { ts: number; amount: number; category: string; note: string }
const rates = new TtlResultCache<number>(30 * 60_000);
export function clearExchangeRateCache(): void { rates.clear(); }
function expenseFile(): string { return path.join(app.getPath("userData"), "expenses.json"); }
function loadExpenses(): ExpenseRecord[] {
  try { return JSON.parse(fs.readFileSync(expenseFile(), "utf8")); }
  catch { return []; }
}
function saveExpenses(records: ExpenseRecord[]): void { fs.writeFileSync(expenseFile(), JSON.stringify(records, null, 2), "utf8"); }
async function recordExpense(args: ToolArguments): Promise<string> {
  const value = Number(args.amount);
  if (!Number.isFinite(value) || value <= 0) return "[错误] amount 必须是正数";
  const ledger = loadExpenses();
  const entry: ExpenseRecord = { ts: Date.now(), amount: value, category: String(args.category || "其他"), note: String(args.note || "") };
  ledger.push(entry);
  saveExpenses(ledger);
  console.log("[LifeTools]", "记账:", entry);
  return `[record_expense] 已记录：${value} 元 / ${entry.category} / ${entry.note}`;
}
async function queryExpense(args: ToolArguments): Promise<string> {
  const lookback = Number(args.days) || 30;
  const earliest = Date.now() - lookback * 86400_000;
  let ledger = loadExpenses().filter(entry => entry.ts >= earliest);
  if (args.category) ledger = ledger.filter(entry => entry.category === args.category);
  if (ledger.length === 0) return `[query_expense] 最近 ${lookback} 天没有记账记录`;
  if (args.summary) {
    const sum = ledger.reduce((subtotal, entry) => subtotal + entry.amount, 0);
    const categories: Record<string, number> = {};
    for (const entry of ledger) categories[entry.category] = (categories[entry.category] || 0) + entry.amount;
    return `[query_expense] 最近 ${lookback} 天共 ${ledger.length} 笔，合计 ${sum.toFixed(2)} 元\n分类：${JSON.stringify(categories)}`;
  }
  const rows = ledger.map(entry => {
    const stamp = new Date(entry.ts).toLocaleDateString(getDateLocale(), { timeZone: currentUserTimezone() });
    return `${stamp} ${entry.amount}元 ${entry.category} ${entry.note}`;
  });
  return `[query_expense] 最近 ${lookback} 天 ${ledger.length} 笔：\n${rows.join("\n")}`;
}
function registerExpenseTools(): void {
  const HANDLER_record_expense = recordExpense;
  const HANDLER_query_expense = queryExpense;
  toolRegistry.register({
  "id": "record_expense",
  "name": "记账",
  "description": "记录一笔支出。\n\n何时用：\n- 用户说「花了 X 元买 Y」「记一下支出」「记账」\n- 用户提到具体金额和用途\n\n不要用于：\n- 查账（用 query_expense）\n- 收入记录（暂不支持）\n\n参数：amount（金额，数字），category（分类：餐饮/交通/购物/娱乐/生活/其他），note（备注）。",
  "enabled": true,
  "risk": "safe",
  "modes": [
    "work"
  ],
  "effectKind": "external_side_effect",
  "inputSchema": {
    "type": "object",
    "properties": {
      "amount": {
        "type": "number",
        "description": "金额（元）"
      },
      "category": {
        "type": "string",
        "description": "分类：餐饮/交通/购物/娱乐/生活/其他"
      },
      "note": {
        "type": "string",
        "description": "备注"
      }
    },
    "required": [
      "amount"
    ]
  }
, execute: HANDLER_record_expense });
  toolRegistry.register({
  "id": "query_expense",
  "name": "查账",
  "description": "查询支出记录。\n\n何时用：\n- 用户问「这个月花了多少」「最近记账」「支出明细」\n- 用户想看支出汇总\n\n不要用于：\n- 记新的一笔（用 record_expense）\n\n参数：days（最近 N 天，默认 30），category（可选，按分类过滤），summary（可选，true 只返回汇总）。",
  "enabled": true,
  "risk": "safe",
  "modes": [
    "work"
  ],
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "days": {
        "type": "number",
        "description": "最近 N 天，默认 30"
      },
      "category": {
        "type": "string",
        "description": "可选，按分类过滤"
      },
      "summary": {
        "type": "boolean",
        "description": "可选，true 只返回汇总"
      }
    }
  }
, execute: HANDLER_query_expense });
}
async function exchangeRate(args: ToolArguments): Promise<string> {
  const source = String(args.from || "USD").toUpperCase();
  const target = String(args.to || "CNY").toUpperCase();
  const quantity = Number(args.amount) || 1;
  if (source === target) return `[exchange_rate] ${quantity} ${source} = ${quantity} ${target}（同币种）`;
  const identity = source + "|" + target;
  const saved = rates.get(identity);
  if (saved) {
    const stamp = new Date(saved.at).toLocaleString("zh-CN", { hour12: false });
    const converted = (quantity * saved.value).toFixed(2);
    return `[缓存] 汇率获取于 ${stamp}，30 分钟内复用\n[exchange_rate] ${quantity} ${source} = ${converted} ${target}（汇率 ${saved.value}，更新于 ${new Date(saved.at).toLocaleDateString(getDateLocale(), { timeZone: currentUserTimezone() })}）`;
  }
  const endpoint = `https://api.frankfurter.app/latest?from=${source}&to=${target}`;
  const reply = await fetch(endpoint);
  if (!reply.ok) return `[错误] 汇率查询失败：HTTP ${reply.status}`;
  const payload = await reply.json() as { rates?: Record<string, number> };
  const multiplier = payload.rates?.[target];
  if (!multiplier) return `[exchange_rate] 查不到 ${source} → ${target}，可能是不支持的币种`;
  const converted = (quantity * multiplier).toFixed(2);
  rates.set(identity, multiplier);
  return `[exchange_rate] ${quantity} ${source} = ${converted} ${target}（汇率 ${multiplier}，更新于 ${new Date().toLocaleDateString(getDateLocale(), { timeZone: currentUserTimezone() })}）`;
}
function registerExchangeRateTool(): void {
  const HANDLER_exchange_rate = exchangeRate;
  toolRegistry.register({
  "id": "exchange_rate",
  "name": "汇率查询",
  "description": "查询货币汇率并换算。\n\n何时用：\n- 用户问「X 美元等于多少人民币」「100 日元换多少人民币」\n- 用户提到货币换算\n\n不要用于：\n- 加密货币（不支持）\n- 历史汇率（只支持最新）\n\n参数：from（源货币代码，如 USD/EUR/JPY/CNY），to（目标货币），amount（金额，默认 1）。",
  "enabled": true,
  "risk": "network",
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from": {
        "type": "string",
        "description": "源货币代码，如 USD/EUR/JPY/CNY"
      },
      "to": {
        "type": "string",
        "description": "目标货币代码"
      },
      "amount": {
        "type": "number",
        "description": "金额，默认 1"
      }
    },
    "required": [
      "from",
      "to"
    ]
  }
, execute: HANDLER_exchange_rate });
}
type TranslationSettings = { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: "openai" | "anthropic" | "responses" };
let translationReader: (() => TranslationSettings | null) | null = null;
export function setTranslateConfig(getter: () => { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: "openai" | "anthropic" | "responses" } | null): void {
  translationReader = getter;
}
async function translateText(args: ToolArguments): Promise<string> {
  const original = String(args.text || "");
  const language = String(args.to || "");
  if (!original || !language) return "[错误] text 和 to 不能为空";
  const profile = translationReader?.();
  if (!profile || !profile.apiKey) return "[错误] 未配置模型，翻译不可用";
  const { getAdapterForConfig } = await import("../vendors");
  const hint = args.from ? `（源语言：${args.from}）` : "（自动检测源语言）";
  const instruction = `你是翻译器${hint}。把以下文本翻译成${language}，只输出译文，不要任何解释或额外文字。`;
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), resolveTimeoutPolicy({ stage: "external-http" }).totalMs);
  try {
    const vendor = getAdapterForConfig(profile);
    const request = vendor.buildRequest({ model: profile.model,
      messages: [{ role: "system", content: instruction }, { role: "user", content: original }], maxTokens: 2000, stream: false }, profile);
    const reply = await fetch(request.url, { method: "POST", signal: cancellation.signal, headers: request.headers, body: request.body });
    if (!reply.ok) return `[错误] 翻译失败：HTTP ${reply.status}`;
    const payload = await reply.json();
    const translation = vendor.parseResponse(payload).text.trim();
    if (!translation) return "[错误] 翻译返回空";
    return `[translate] ${translation}`;
  } catch (failure) { return "[错误] 翻译失败：" + (failure instanceof Error ? failure.message : String(failure)); }
  finally { clearTimeout(deadline); }
}
function registerTranslateTool(): void {
  const HANDLER_translate = translateText;
  toolRegistry.register({
  "id": "translate",
  "name": "翻译",
  "description": "翻译文本。\n\n何时用：\n- 用户说「翻译 X」「这句话用 Y 语怎么说」「X 是什么意思」\n- 用户问外语词义\n\n不要用于：\n- 用户用中文问中文能答的事\n- 长文档翻译（建议分段）\n\n参数：text（要翻译的文本），to（目标语言，如「英文」「中文」「日文」），from（可选，源语言，默认自动检测）。",
  "enabled": true,
  "risk": "network",
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "description": "要翻译的文本"
      },
      "to": {
        "type": "string",
        "description": "目标语言，如「英文」「中文」「日文」"
      },
      "from": {
        "type": "string",
        "description": "可选，源语言，默认自动检测"
      }
    },
    "required": [
      "text",
      "to"
    ]
  }
, execute: HANDLER_translate });
}
type Replacement = { old_string: string; new_string: string };
function requestedEdits(args: ToolArguments): Replacement[] {
  const provided = Array.isArray(args.edits) ? args.edits : [];
  return provided.filter((entry): entry is Replacement => typeof entry === "object" && entry !== null &&
    typeof (entry as Record<string, unknown>).old_string === "string" && typeof (entry as Record<string, unknown>).new_string === "string")
    .map(entry => ({ old_string: entry.old_string, new_string: entry.new_string }));
}
async function replaceFile(args: ToolArguments, context?: ToolContext): Promise<string> {
  const target = String(args.file_path || "");
  if (!target) return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "file_path 不能为空", retryable: false });
  return withWorkspaceWrite(target, context, false, lease => replaceObservedFile(args, context, target, lease));
}
async function replaceObservedFile(args: ToolArguments, context: ToolContext | undefined, target: string, lease?: WorkspaceWriteLease): Promise<string> {
  if (lease ? !lease.before.exists : !fs.existsSync(target)) return JSON.stringify({ success: false, errorCode: "FILE_NOT_FOUND",
    error: `文件不存在：${target}。不要重复相同路径，请先用 read_file 或 search_text 确认文件存在。`, retryable: true });
  const replacements = requestedEdits(args);
  if (replacements.length === 0) {
    const before = String(args.old_string ?? "");
    const after = String(args.new_string ?? "");
    if (!before && !after) return JSON.stringify({ success: false, errorCode: "INVALID_INPUT",
      error: "需要提供 old_string/new_string（单处替换）或 edits 数组（多处替换），本次收到的参数键：" + Object.keys(args).join(", "), retryable: false });
    replacements.push({ old_string: before, new_string: after });
  }
  const original = lease ? lease.before.bytes!.toString("utf8") : fs.readFileSync(target, "utf8");
  console.log("[LifeTools]", "str_replace:", target, "edits=" + replacements.length);
  const outcome = applyStrReplaceEdits(original, replacements);
  if (!outcome.ok) return JSON.stringify({ success: false, errorCode: outcome.errorCode, error: outcome.error, retryable: false, diagnostic: outcome.diagnostic });
  let after: WorkspaceSnapshot | undefined = lease?.before;
  const writes = beginWriteBatch(context, [target], lease ? { before: () => lease.before, after: () => after } : undefined);
  const review = context?.runId ? reviewTrackerFor() : undefined;
  if (context?.runId) {
    if (!lease) assertWorkspacePathFallback(target, "write", context);
    review!.captureBefore(context.runId, target, undefined, lease?.before, context);
  }
  await writes.run([target], async () => {
    if (lease) {
      after = undefined;
      review?.recordHandleAfter(context!.runId!, target);
      after = await lease.commit(Buffer.from(outcome.newContent, "utf8"), "replace");
    } else {
      assertWorkspacePathFallback(target, "write", context);
      fs.writeFileSync(target, outcome.newContent, "utf8");
    }
  });
  if (!lease) assertWorkspacePathFallback(target, "write", context, "unknown");
  const bytes = lease ? after!.size : fs.statSync(target).size;
  console.log("[LifeTools]", "str_replace:", target, "size=" + bytes,
    outcome.eolNormalized ? "eolNormalized=true" : "", outcome.whitespaceNormalized ? "whitespaceNormalized=true" : "");
  const fileChanges = outcome.segments.map(segment => ({ file: target, kind: "modified" as const,
    insertions: countLines(segment.afterLines.join("\n")), deletions: countLines(segment.beforeLines.join("\n")),
    diff: buildReplacedDiff(segment.beforeLines, segment.afterLines) }));
  return JSON.stringify({ tool: "str_replace", filePath: target, action: "modified", sizeBytes: bytes, success: true,
    eolNormalized: outcome.eolNormalized, whitespaceNormalized: outcome.whitespaceNormalized,
    appliedEdits: outcome.appliedEdits, changes: finalizeFileChanges(fileChanges) });
}
function registerStrReplaceTool(): void {
  const HANDLER_str_replace = replaceFile;
  toolRegistry.register({
  "id": "str_replace",
  "name": "精确替换",
  "description": "对单个文件应用精确的字符串替换（内容锚点，不依赖行号）。\n\n何时用：\n- 修改现有文件中的一处或多处特定片段（多处用 edits 一次调用完成）\n- 用户要「把 X 改成 Y」「把第 N 行的 A 替换成 B」\n- 修正当前工作区笔记 / 文档的局部内容\n- 填充空文件：文件存在但内容为空时，old_string 传空字符串，new_string 传完整内容，即可整体写入\n\n不要用于：\n- 多文件批量修改（用 apply_patch 补丁格式）\n- 整文件重写（用 write_file）\n- 新建文件（用 write_file）\n\n参数：file_path（文件路径），old_string（要替换的原文本，须精确匹配含缩进；文件为空时传空字符串做整体写入），new_string（替换后的文本）；同一文件多处修改可改用 edits 数组（每项含 old_string / new_string，按顺序应用，任一处失败则整体不生效）。\nold_string 必须在文件中唯一；匹配多处会报错，需要更长的上下文使其唯一。缩进/空白略有出入时会自动做归一化匹配，命中后按文件真实缩进写入。",
  "enabled": true,
  "risk": "fs-write",
  "modes": [
    "code",
    "work"
  ],
  "effectKind": "mutation",
  "verificationPolicy": "code",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "文件绝对路径"
      },
      "old_string": {
        "type": "string",
        "description": "要替换的原文本（必须精确匹配，含缩进）。与 edits 二选一"
      },
      "new_string": {
        "type": "string",
        "description": "替换后的文本。与 edits 二选一"
      },
      "edits": {
        "type": "array",
        "description": "批量替换（与 old_string/new_string 二选一）：一次调用完成同一文件多处修改，按数组顺序依次应用，任一处失败则整体不生效",
        "items": {
          "type": "object",
          "properties": {
            "old_string": {
              "type": "string",
              "description": "要替换的原文本（必须精确匹配，含缩进）"
            },
            "new_string": {
              "type": "string",
              "description": "替换后的文本"
            }
          },
          "required": [
            "old_string",
            "new_string"
          ]
        }
      }
    },
    "required": [
      "file_path"
    ]
  }
, execute: HANDLER_str_replace });
}
export function registerLifeTools(): void {
  registerExpenseTools();
  registerExchangeRateTool();
  registerTranslateTool();
  registerStrReplaceTool();
  logger.info(LogTag.LifeTools, "registered: record_expense / query_expense / exchange_rate / translate / str_replace");
}
