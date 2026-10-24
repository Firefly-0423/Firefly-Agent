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
