import { contextFail } from "./context-contracts";

// Context may discuss credential field names. M's conservative fact extractor is not
// a context filter: reject credential-shaped values, not the words in code docs.
const label = String.raw`(?:password|passwd|passphrase|credential|api[ _-]?key|(?:access|refresh|session|id|auth)[ _-]?token|token|(?:client[ _-]?)?secret|private[ _-]?key|密码|口令|私钥|密钥|令牌)`;
const sensitiveKey = new RegExp(`^${label}$`, "i");
const assignment = new RegExp(`(?:^|[^A-Za-z0-9_])${label}["']?\\s*(?::|=|：)\\s*(?=["']?[^\\s"',;{}\\[\\]])`, "gi");
const personalDisclosure = new RegExp(`(?:\\bmy\\s+${label}\\s+is\\s+|(?:我的)?(?:密码|口令|私钥|密钥|令牌)是)(?=[^\\s"',;{}])`, "gi");
const typeField = new RegExp(`(${label}\\s*:\\s*)(?:string|number|boolean|unknown|never|any)(?=\\s*[;,}])`, "gi");
const credential = /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9_.~+/=-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
// A public token prefix discloses no secret. Nothing except that prefix and a full
// mask is accepted; suffixes, annotations, escapes and concatenations remain denied.
const mask = String.raw`(?:gh[opusr]_|github_pat_|sk-)?\*{3,}`;
const maskedValue = new RegExp(`^${mask}$`);
const maskedAssignmentValue = new RegExp(`^(?:${mask}|(["'])${mask}\\1)(?=[ \\t]*(?:$|[\\r\\n]))`);

function hasUnmaskedValue(text: string, starts: RegExp): boolean {
 for (const match of text.matchAll(starts)) {
  if (!maskedAssignmentValue.test(text.slice(match.index! + match[0].length))) return true;
 }
 return false;
}

/** JSON.parse discards duplicate keys; never discard an earlier secret-bearing value. */
function assertUniqueJsonKeys(text: string): void {
 const stack: Array<Set<string> | null> = [];
 let tokens = 0;
 for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
  if (++tokens > 200000) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const token = match[0];
  if (token === "{") stack.push(new Set());
  else if (token === "[") stack.push(null);
  else if (token === "}" || token === "]") stack.pop();
  else if (token.startsWith('"') && /^\s*:/.test(text.slice(match.index! + token.length))) {
   const keys = stack.at(-1);
   const key: string = JSON.parse(token);
   if (keys?.has(key)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
   keys?.add(key);
  }
 }
}
/** Reason-only, Main context screening. It is deliberately not a complete DLP guarantee. */
export function assertContextSecretFree(value: unknown): void {
 const active = new Set<object>();
 let nodes = 0;
 function visit(item: unknown, depth: number): void {
  if (++nodes > 200000 || depth > 100) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if (typeof item === "string") {
   // Tool observations contain nested JSON strings. Decode only complete JSON,
   // then apply the same checks to every value (including escaped secret fields).
   // The shared depth/node budget also bounds nested serialization.
   if (/^\s*[{[\"]/.test(item)) {
    let parsed: unknown;
    try { parsed = JSON.parse(item); } catch { parsed = undefined; }
    if (parsed !== undefined) { assertUniqueJsonKeys(item); visit(parsed, depth + 1); return; }
   }
   const text = item.normalize("NFKC");
   // Only syntactically recognizable TS declarations can omit primitive type names.
   const screened=/\b(?:type|interface)\s+[A-Za-z_$][\w$]*(?:\s*=)?\s*\{/.test(text)?text.replace(typeField,"$1"):text;
   if (credential.test(text) || hasUnmaskedValue(text, personalDisclosure) || hasUnmaskedValue(screened, assignment)) contextFail("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
   return;
  }
  if (item === null || typeof item !== "object") return;
  if (active.has(item)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  active.add(item);
  for (const [key, child] of Object.entries(item)) {
   // JSON keys are input too; decoding must not hide credential-shaped key text.
   visit(key, depth + 1);
   if (sensitiveKey.test(key.normalize("NFKC")) && (typeof child === "number" || typeof child === "boolean")) contextFail("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
   if (sensitiveKey.test(key.normalize("NFKC")) && typeof child === "string" && child.trim() && !maskedValue.test(child.trim())) contextFail("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
   visit(child, depth + 1);
  }
  active.delete(item);
 }
 visit(value, 0);
}

const OMITTED = "[疑似敏感内容，已从模型上下文中省略]";
const typeDeclaration = /\b(?:type|interface)\s+[A-Za-z_$][\w$]*(?:\s*=)?\s*\{/;
const primitiveTypeValue = /^(?:string|number|boolean|unknown|never|any)(?=\s*[;,}])/;
const privateKeyBlock = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gi;
const credentialEverywhere = new RegExp(credential.source, "gi");

function passes(value: unknown): boolean {
 try { assertContextSecretFree(value); return true; }
 catch (error) { if (error instanceof Error && error.message === "MEMORY_CONTEXT_TRANSCRIPT_SECRET") return false; throw error; }
}

// Every round re-assembles the whole conversation, so the same long strings (file contents, tool results) are
// screened again and again. The screen is a pure function of the string, so its result is remembered.
const SCREEN_CACHE_MIN_CHARS = 256;
const SCREEN_CACHE_MAX_CHARS = 16_000_000;
const screenedStrings = new Map<string, string>();
let screenedChars = 0;
function rememberScreened(item: string, screened: string): void {
 screenedStrings.set(item, screened);
 screenedChars += item.length;
 for (const [oldest] of screenedStrings) {
  if (screenedChars <= SCREEN_CACHE_MAX_CHARS) break;
  screenedStrings.delete(oldest);
  screenedChars -= oldest.length;
 }
}

/** The text a context message's content stands for: the string itself, or its text blocks joined by newlines. */
function contentText(content: unknown): string | undefined {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return undefined;
 return content.filter((block): block is { type: "text"; text: string } =>
  !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
  .map(block => block.text).join("\n");
}

/** The blocks with every text block replaced by one holding `text`, where the first text block was; images kept. */
function withOneTextBlock(blocks: unknown[], text: string): unknown[] {
 const isText = (block: unknown) => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
 const first = blocks.findIndex(isText);
 const others = blocks.filter(block => !isText(block));
 others.splice(first < 0 ? others.length : blocks.slice(0, first).filter(block => !isText(block)).length, 0, { type: "text", text });
 return others;
}

/** Replaces each flagged value with *** from where the value starts to the end of its line. */
// One pass over the matches, left to right: the first value on a line that is not already masked is replaced with ***
// to the end of that line, and later matches on the masked part are skipped. The output is built from the untouched
// ranges between them, so the work is linear in the text (rebuilding the string per match was quadratic).
function maskLineValues(text: string, starts: RegExp, skip?: (rest: string) => boolean): string {
 const parts: string[] = [];
 let cursor = 0;
 for (const match of text.matchAll(starts)) {
  const at = match.index! + match[0].length;
  if (at < cursor) continue;
  const newline = text.slice(at).search(/[\r\n]/);
  const lineEnd = newline < 0 ? text.length : at + newline;
  const value = text.slice(at, lineEnd);
  if (maskedAssignmentValue.test(value) || skip?.(value)) continue;
  parts.push(text.slice(cursor, at), "***");
  cursor = lineEnd;
 }
 if (cursor === 0 && parts.length === 0) return text;
 parts.push(text.slice(cursor));
 return parts.join("");
}

function maskText(item: string): string {
 const text = item.normalize("NFKC");
 if (passes(text)) return item;
 let masked = text.replace(privateKeyBlock, "***").replace(credentialEverywhere, "***");
 masked = maskLineValues(masked, personalDisclosure);
 const declaration = typeDeclaration.test(masked);
 masked = maskLineValues(masked, assignment, rest => declaration && primitiveTypeValue.test(rest));
 return passes(masked) ? masked : OMITTED;
}

/**
 * The model context version of assertContextSecretFree: instead of failing the whole run, each credential-shaped
 * value is replaced with *** (to the end of its line), and anything that still does not pass the screen is omitted.
 * Ordinary code such as `token: object` or `apiKey = model.apiKey` trips the screen, and a run that reads code must
 * not die for it. The result always passes assertContextSecretFree; the stored transcript is not changed.
 */
export function maskContextSecrets<T>(value: T): T {
 const active = new Set<object>();
 let nodes = 0;
 function visit(item: unknown, depth: number): unknown {
  if (++nodes > 200000 || depth > 100) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  if (typeof item === "string") {
   if (item.length < SCREEN_CACHE_MIN_CHARS) return screenString(item, depth);
   const known = screenedStrings.get(item);
   if (known !== undefined) return known;
   const screened = screenString(item, depth);
   rememberScreened(item, screened);
   return screened;
  }
  if (item === null || typeof item !== "object") return item;
  if (active.has(item)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  active.add(item);
  let changed = false;
  const entries = Object.entries(item).map(([key, child]): [string, unknown] => {
   let nextKey = key;
   if (!passes(key)) { nextKey = `***${nodes}`; changed = true; }
   const sensitive = sensitiveKey.test(key.normalize("NFKC"));
   let next: unknown;
   if (sensitive && (typeof child === "number" || typeof child === "boolean")) next = "***";
   else if (sensitive && typeof child === "string" && child.trim() && !maskedValue.test(child.trim())) next = "***";
   else next = visit(child, depth + 1);
   if (next !== child) changed = true;
   return [nextKey, next];
  });
  active.delete(item);
  if (!changed) return item;
  if (Array.isArray(item)) return entries.map(([, child]) => child);
  const result = Object.fromEntries(entries) as Record<string, unknown>;
  // A context message's text is its content's text (validateUnit checks it): when the input kept that invariant, rebuild
  // text from the masked content, since masking the two separately can mask the same secret differently.
  const original = item as Record<string, unknown>;
  if (typeof original.text === "string" && original.content !== undefined && contentText(original.content) === original.text) {
   const derived = contentText(result.content);
   if (derived !== undefined && passes(derived)) result.text = derived;
   else if (derived !== undefined) {
    // A secret split across text blocks passes block by block: mask the joined text and keep it as one text block.
    const joined = maskText(derived);
    result.text = joined;
    result.content = typeof result.content === "string" ? joined : withOneTextBlock(result.content as unknown[], joined);
   }
  }
  return result;
 }
 function screenString(item: string, depth: number): string {
   if (/^\s*[{[\"]/.test(item)) {
    let parsed: unknown;
    try { parsed = JSON.parse(item); } catch { parsed = undefined; }
    if (parsed !== undefined) {
     try { assertUniqueJsonKeys(item); } catch { return OMITTED; }
     const masked = visit(parsed, depth + 1);
     return masked === parsed ? item : JSON.stringify(masked);
    }
   }
   return maskText(item);
 }
 // Every leaf is screened above: a rewritten string passed `passes(masked)` in maskText or became OMITTED, a sensitive
 // key's value became ***, a flagged key was renamed, and re-serialized JSON parses back to those same leaves. So the
 // result passes assertContextSecretFree by construction (source-secret-mask.test.ts checks it) without a second full
 // pass over the whole conversation every round.
 return visit(value, 0) as T;
}
