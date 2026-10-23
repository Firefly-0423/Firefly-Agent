import { canonicalJson } from "../memory-core/repository-types";
import type { PendingChatAttachment } from "../../shared/chat-types";
import type { TranscriptEntry, TranscriptUserPayload } from "../orchestrator/conversation-transcript-types";
import type { OpenAIContentBlock } from "../orchestrator/vendors/types";
import { copyResponseJson } from "../orchestrator/vendors/response-request-snapshot";
import { contextFail, type ContextMessage } from "./context-contracts";
import { assertContextSecretFree } from "./source-secret-screen";
import { validateUnit } from "./token-budget";

declare const grantBrand: unique symbol;
export type MainAttachmentGrant = Readonly<{ [grantBrand]: true }>;
export interface MainAttachmentSource {
 readonly sessionId: string;
 readonly userTurnId: string;
 readonly userRevision: number;
 readonly userText: string;
 readonly attachments: readonly PendingChatAttachment[];
}
interface Projection { message: ContextMessage; assertCurrent(): void }
type ProjectionMutation = (source: Readonly<MainAttachmentSource>) => Promise<void>;
interface GrantRecord {
 source: MainAttachmentSource;
 key: string;
 generation: number;
 beforeReprepare(): Promise<void>;
 assertCurrent(): void;
 track<T>(operation: () => Promise<T>): Promise<T>;
 prepared?: ContextMessage;
 pending?: Promise<ContextMessage>;
 reprepared?: Promise<ContextMessage>;
}
const grants = new WeakMap<object, GrantRecord>();
const providers = new WeakMap<object, (sessionId: string, entry: TranscriptEntry) => Projection | null>();
const mutationObservers = new WeakMap<object, (sessionId: string, listener: ProjectionMutation) => () => void>();
const deny = (): never => contextFail("MEMORY_ATTACHMENT_DENIED");
function frozen<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function id(value: unknown): string { if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return deny(); return value; }
/** Same stable reference fields as canonical storage; display status and readScope are not authority.
 * The issuer's freshness callback must independently bind the complete stored attachment list. */
export function mainAttachmentReferences(attachments: readonly PendingChatAttachment[]): PendingChatAttachment[] {
 const copy = copyResponseJson(attachments, true, deny);
 if (!Array.isArray(copy) || !copy.length || copy.length > 1000) return deny();
 return copy.map(item => {
  if (!item || !["image", "document"].includes(item.kind) || typeof item.name !== "string" || typeof item.filePath !== "string" || !item.filePath) return deny();
  return { kind: item.kind, name: item.name, filePath: item.filePath,
   ...(item.kind === "image" && item.mime ? { mime: item.mime } : {}),
   ...(item.kind === "image" && item.caption ? { caption: item.caption } : {}),
   ...(item.kind === "image" && item.hasAnnotations ? { hasAnnotations: true } : {}) };
 });
}
function identity(source: Pick<MainAttachmentSource, "sessionId" | "userTurnId" | "userRevision">): string { return canonicalJson([source.sessionId, source.userTurnId, source.userRevision]); }
function fingerprint(text: string, attachments: readonly PendingChatAttachment[]): string { return canonicalJson([text, mainAttachmentReferences(attachments)]); }
function requireGrant(grant: MainAttachmentGrant): GrantRecord { const record = grant && typeof grant === "object" ? grants.get(grant) : undefined; if (!record) return deny(); record.assertCurrent(); return record; }
/** Main-only. Issuers are retained by the authenticated owner, never exposed to IPC. */
export function createMainAttachmentProjectionAuthority() {
 const entries = new Map<string, GrantRecord>(), pending = new Set<Promise<unknown>>(), listeners = new Set<{sessionId: string; listener: ProjectionMutation}>();
 let closed = false, closePromise: Promise<void> | undefined;
 const quiesce = () => { closed = true; entries.clear(); listeners.clear(); };
 function track<T>(operation: () => Promise<T>): Promise<T> {
  if (closed) return deny();
  // Register before invoking user-supplied work: close may reenter synchronously.
  const result = Promise.resolve().then(operation); pending.add(result);
  void result.then(() => pending.delete(result), () => pending.delete(result)); return result;
 }
 const token = Object.freeze({});
 mutationObservers.set(token, (sessionId, listener) => {
  if (closed || typeof listener !== "function") return deny(); id(sessionId);
  const entry = { sessionId, listener }; listeners.add(entry); return () => { listeners.delete(entry); };
 });
 providers.set(token, (sessionId, entry) => {
  if (closed) return deny();
  const payload: TranscriptUserPayload | undefined = entry.kind === "user" ? entry.payload : entry.kind === "turn_rewind" && entry.payload.disposition === "replace_user" ? entry.payload.replacementUser : undefined;
  if (!payload?.attachments?.length || !entry.turnId || !entry.revision) return null;
  const record = entries.get(identity({ sessionId, userTurnId: entry.turnId, userRevision: entry.revision }));
  if (!record) return null;
  record.assertCurrent();
  if (fingerprint(payload.text, payload.attachments) !== record.key || !record.prepared) return deny();
  const generation = record.generation;
  return { message: structuredClone(record.prepared), assertCurrent() { record.assertCurrent(); if (record.generation !== generation) return deny(); } };
 });
 return Object.freeze({ token,
  issue(input: MainAttachmentSource & { assertCurrent(): void; signal?: AbortSignal }): MainAttachmentGrant {
   if (closed || typeof input.assertCurrent !== "function") return deny();
   input.assertCurrent(); if (input.signal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
   const source = copyResponseJson({ sessionId: input.sessionId, userTurnId: input.userTurnId, userRevision: input.userRevision, userText: input.userText, attachments: input.attachments }, true, deny);
   id(source.sessionId); id(source.userTurnId);
   if (!Number.isSafeInteger(source.userRevision) || source.userRevision < 1 || typeof source.userText !== "string") return deny();
   const key = fingerprint(source.userText, source.attachments), location = identity(source), assertSource = input.assertCurrent, signal = input.signal;
   frozen(source);
   const record: GrantRecord = { source, key, generation: 1, track,
    async beforeReprepare() { await Promise.all([...listeners].filter(item => item.sessionId === source.sessionId).map(item => item.listener(source))); },
    assertCurrent() {
    if (signal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
    if (closed || entries.get(location) !== record) return deny();
    assertSource();
   } };
   const grant = Object.freeze({}) as MainAttachmentGrant;
   entries.set(location, record); grants.set(grant, record); record.assertCurrent(); return grant;
  },
  revokeTurn(sessionId: string, userTurnId: string): void { for (const [key, record] of entries) if (record.source.sessionId === sessionId && record.source.userTurnId === userTurnId) entries.delete(key); },
  revokeSession(sessionId: string): void { for (const [key, record] of entries) if (record.source.sessionId === sessionId) entries.delete(key); },
  quiesce,
  close(): Promise<void> {
   if (closePromise) return closePromise;
   quiesce(); closePromise = Promise.allSettled([...pending]).then(() => undefined); return closePromise;
  },
 });
}
export function readMainAttachmentGrant(grant: MainAttachmentGrant): Readonly<MainAttachmentSource> { return requireGrant(grant).source; }
function projectedMessage(record: GrantRecord, blocks: OpenAIContentBlock[], captionOnly = false): ContextMessage {
 const copy = copyResponseJson(blocks, false, deny);
 if (!Array.isArray(copy) || copy.some(block => !block || typeof block !== "object" || !["text", "image_url"].includes(block.type)
   || captionOnly && block.type !== "text"
   || block.type === "image_url" && (typeof block.image_url?.url !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(block.image_url.url)))) return deny();
 const content: OpenAIContentBlock[] = [{ type: "text", text: record.source.userText }, ...copy];
 const message: ContextMessage = { role: "user", text: content.filter(block => block.type === "text").map(block => block.text).join("\n"), content };
 validateUnit({ id: "authorized-attachment", kind: "recent", messages: [message] }); assertContextSecretFree(message); record.assertCurrent(); return message;
}
/** No filesystem access is performed here. The trusted materializer cannot run before authorization. */
export async function prepareMainAttachmentProjection(grant: MainAttachmentGrant, materialize: (source: Readonly<MainAttachmentSource>) => Promise<OpenAIContentBlock[]>): Promise<ContextMessage> {
 const record = requireGrant(grant);
 if (!record.pending) record.pending = record.track(async () => {
  record.assertCurrent(); const blocks = await materialize(record.source); record.assertCurrent();
  const message = projectedMessage(record, blocks); record.prepared = frozen(message); return structuredClone(message);
 });
 const message = await (record.reprepared ?? record.pending); record.assertCurrent(); return structuredClone(message);
}
/** One Main-owned direct-image to caption transition. It never changes canonical user bytes/revision.
 * Old send fences retire synchronously; all S publications retire before any caption reader starts. */
export async function reprepareMainAttachmentProjection(grant: MainAttachmentGrant, materialize: (source: Readonly<MainAttachmentSource>) => Promise<OpenAIContentBlock[]>): Promise<ContextMessage> {
 const record = requireGrant(grant);
 if (!record.reprepared) {
  if (!record.prepared || !Array.isArray(record.prepared.content) || !record.prepared.content.some(block => block.type === "image_url")) return deny();
  record.generation++; record.prepared = undefined;
  record.reprepared = record.track(async () => {
   record.assertCurrent(); await record.beforeReprepare(); record.assertCurrent();
   const blocks = await materialize(record.source); record.assertCurrent();
   const message = projectedMessage(record, blocks, true); record.prepared = frozen(message); return structuredClone(message);
  });
 }
 const message = await record.reprepared; record.assertCurrent(); return structuredClone(message);
}
export function observeMainAttachmentProjection(token: object, sessionId: string, listener: ProjectionMutation): () => void {
 const observe = token && typeof token === "object" ? mutationObservers.get(token) : undefined;
 if (!observe) return deny(); return observe(sessionId, listener);
}
export function readMainAttachmentProjection(token: object, sessionId: string, entry: TranscriptEntry): Projection | null {
 const read = token && typeof token === "object" ? providers.get(token) : undefined;
 if (!read) return deny(); return read(sessionId, entry);
}
