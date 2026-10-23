import type { MainActorAuthority, MainActorContext } from "../memory-core/main-actor-authority";
import { objectFields, parseInternalId, positiveRevision } from "../memory-core/command-validation";
import type { MemorySessionMode, MemorySessionModeBinding, MemorySessionModes } from "./memory-session-modes";

export type MemoryEntryKind = "desktop" | "channel" | "scheduler" | "child" | "proactive";
export interface MemoryRunIdentity {
  entry: MemoryEntryKind; sessionId: string; runId: string; modelProfileId: string; sessionMode: MemorySessionMode;
}
declare const runGrant: unique symbol;
export type MemoryRunGrant = Readonly<{ [runGrant]: true }>;
export interface MemoryRunContext {
  readonly identity: Readonly<MemoryRunIdentity>;
  readonly profileRevision: number;
  readonly actorToken: object;
  readonly sourceProvider: object;
  readonly readActorTokens: readonly object[];
  readonly signal: AbortSignal;
  readonly accountKey?: string;
}
interface EntryIdentity { revision: number; accountKey?: string; signal?: AbortSignal }
interface Options {
  actors: MainActorAuthority;
  sessionModes: MemorySessionModes;
  resolveProfile(id: string): { id: string; revision: number } | null;
  /** Main adapter validates the entry/session against its authenticated host, never incoming payload fields. */
  resolveEntry(identity: Readonly<MemoryRunIdentity>, actor: MainActorContext): EntryIdentity | null;
  canRead(actor: MainActorContext, target: MainActorContext): boolean;
}
interface RecordState {
  context: Readonly<MemoryRunContext>; mode: Readonly<MemorySessionModeBinding>;
  profileRevision: number; entryRevision: number; controller: AbortController; entrySignal?: AbortSignal;
}
const fail = (code: string): never => { throw new Error(code); };
function identity(value: unknown): Readonly<MemoryRunIdentity> {
  const input = objectFields(value, ["entry", "sessionId", "runId", "modelProfileId", "sessionMode"]);
  if (!["desktop", "channel", "scheduler", "child", "proactive"].includes(input.entry as string)
    || !["persistent", "temporary"].includes(input.sessionMode as string)) fail("MEMORY_RUN_IDENTITY_DENIED");
  return Object.freeze({ entry: input.entry as MemoryEntryKind, sessionId: parseInternalId(input.sessionId), runId: parseInternalId(input.runId),
    modelProfileId: parseInternalId(input.modelProfileId), sessionMode: input.sessionMode as MemorySessionMode });
}
/** Extra run lifetime binding around the existing Main actor/source authority, not a new source of trust. */
export function createMemoryRunAuthority(options: Options) {
  const grants = new WeakMap<object, RecordState>();
  function inspect(context: Readonly<Omit<MemoryRunContext, "profileRevision">>) {
    if (!(context.signal instanceof AbortSignal) || context.signal.aborted) fail("MEMORY_RUN_CANCELLED");
    const actor = options.actors.requireActor(context.actorToken), mode = options.sessionModes.capture(context.identity.sessionId);
    if (actor.sessionId !== context.identity.sessionId || actor.sessionMode !== context.identity.sessionMode || mode.mode !== context.identity.sessionMode) fail("MEMORY_RUN_IDENTITY_DENIED");
    if (actor.adapter !== context.sourceProvider) fail("MEMORY_RUN_SOURCE_DENIED");
    if (!Array.isArray(context.readActorTokens) || context.identity.sessionMode === "temporary" && context.readActorTokens.length) fail("MEMORY_RUN_READ_DENIED");
    for (const token of context.readActorTokens) {
      const target = options.actors.requireActor(token);
      if (target.sessionMode !== "persistent" || options.canRead(actor, target) !== true) fail("MEMORY_RUN_READ_DENIED");
    }
    const profile = options.resolveProfile(context.identity.modelProfileId);
    if (!profile || profile.id !== context.identity.modelProfileId) fail("MEMORY_RUN_PROFILE_DENIED");
    const profileRevision = positiveRevision(profile!.revision);
    const entry = options.resolveEntry(context.identity, actor);
    if (!entry || entry.signal !== undefined && (!(entry.signal instanceof AbortSignal) || entry.signal.aborted)) fail("MEMORY_RUN_ENTRY_DENIED");
    if (context.identity.entry === "channel" && !entry!.accountKey) fail("MEMORY_RUN_ACCOUNT_DENIED");
    const accountKey = entry!.accountKey;
    if (accountKey !== undefined && (typeof accountKey !== "string" || !accountKey.trim() || accountKey !== accountKey.trim() || accountKey.length > 512 || /[\x00-\x1f\x7f]/.test(accountKey))) fail("MEMORY_RUN_ACCOUNT_DENIED");
    return { mode, profileRevision, entryRevision: positiveRevision(entry!.revision), accountKey, entrySignal: entry!.signal };
  }
  return Object.freeze({
    issue(input: { identity: MemoryRunIdentity; actorToken: object; sourceProvider: object; readActorTokens: readonly object[]; signal: AbortSignal }): MemoryRunGrant {
      if (!Array.isArray(input.readActorTokens)) fail("MEMORY_RUN_READ_DENIED");
      const context = Object.freeze({ identity: identity(input.identity), actorToken: input.actorToken, sourceProvider: input.sourceProvider,
        readActorTokens: Object.freeze([...input.readActorTokens]), signal: input.signal });
      const current = inspect(context), grant = Object.freeze({}) as MemoryRunGrant, controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal, ...(current.entrySignal ? [current.entrySignal] : [])]);
      grants.set(grant, { context: Object.freeze({ ...context, profileRevision: current.profileRevision, signal, ...(current.accountKey ? { accountKey: current.accountKey } : {}) }),
        mode: current.mode, profileRevision: current.profileRevision, entryRevision: current.entryRevision, controller, entrySignal: current.entrySignal });
      return grant;
    },
    require(grant: unknown): Readonly<MemoryRunContext> {
      const record = grant && typeof grant === "object" ? grants.get(grant) : undefined;
      if (!record) return fail("MEMORY_RUN_DENIED");
      try {
        const current = inspect(record.context);
        if (current.mode !== record.mode) fail("MEMORY_RUN_SESSION_CHANGED");
        if (current.profileRevision !== record.profileRevision) fail("MEMORY_RUN_PROFILE_CHANGED");
        if (current.entryRevision !== record.entryRevision || current.accountKey !== record.context.accountKey || current.entrySignal !== record.entrySignal) fail("MEMORY_RUN_ENTRY_CHANGED");
        return record.context;
      } catch (error) {
        grants.delete(grant as object); record.controller.abort(error); throw error;
      }
    },
    revoke(grant: MemoryRunGrant): void { const record = grants.get(grant); grants.delete(grant); record?.controller.abort(new Error("MEMORY_RUN_REVOKED")); },
  });
}
export type MemoryRunAuthority = ReturnType<typeof createMemoryRunAuthority>;
