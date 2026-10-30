import { memoryGraphCategory } from "../../shared/memory-graph-categories";
import type { MemoryGraphSummary } from "../../shared/memory-panel-contracts";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryPanelAction, MemoryPanelState, MemoryPanelSourceAudit } from "../../shared/memory-panel-contracts";
import type { MemorySettingsHost } from "../memory-policy/memory-settings-ipc";
import { parseMemoryAutomationConfigure, type MemoryAutomationSettingsHost } from "../memory-policy/memory-automation-settings-ipc";
import { naturalConsentStatement } from "../memory-policy/natural-job-repository";
import { objectFields, parseInternalId, positiveRevision, textField } from "../memory-core/command-validation";
import { canonicalJson } from "../memory-core/repository-types";
import { extractPreference } from "../memory-policy/extractor";
import { createMainSourceRouter } from "../memory-sources/main-source-router";
import { createTaskSourceProvider } from "../memory-sources/task-source-provider";
import { requireBackgroundMemoryIngress, type BackgroundMemoryIngress, type BackgroundMemoryIngressContext, type BackgroundMemoryHost, type BackgroundMemoryPreparedRun } from "./background-memory-ingress";
import { createChannelSourceProvider, channelMemoryAttachments } from "../memory-sources/channel-source-provider";
import { formatChannelUserText } from "../channels/channel-context";
import { requireChannelMemoryIngress, type ChannelMemoryIngress, type ChannelMemoryIngressContext, type ChannelsMemoryHost, type ChannelMemoryPreparedRun } from "./channel-memory-ingress";
import { createSettingsUserSourceProvider } from "../memory-sources/settings-user-source-provider";
import type { PendingChatAttachment, ChatMessage, ChatSession } from "../../shared/chat-types";
import { bindRunAdjustmentPoller, requireRunAdjustmentPermit } from "../chats/pending-adjustment";
import { createMainActorAuthority } from "../memory-core/main-actor-authority";
import { createMainSourceRegistry } from "../memory-sources/source-registry";
import { createDesktopUserSourceProvider } from "../memory-sources/desktop-user-source-provider";
import { createNativeHistoryProvider } from "../memory-sources/native-history-provider";
import { createMainPolicy } from "../memory-policy/main-policy";
import { createMainRecall } from "../memory-recall/main-recall";
import { createMainHistory } from "../memory-history/main-history";
import { createHistoryBudgetStatsRecorder } from "../memory-history/history-budget-stats";
import { getStorageContext } from "../storage/storage-context";
import { createMainUserFactCoordinator } from "../memory-policy/main-user-fact-coordinator";
import { createMainFactSelector } from "../memory-recall/main-fact-selector";
import { projectKeyForWorkspaceRoot } from "../memory-policy/project-scope";
import { resolveProjectNames } from "./project-names";
import type { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import type { FireflyRunOptions } from "../orchestrator/firefly-agent";
import { createTranscriptSink, readTranscriptSinkBinding } from "../orchestrator/transcript-sink";
import type { ModelSettings } from "../settings/model-settings";
import { resolveDefaultModelProfile } from "../settings/model-catalog";
import { createMainDesktopSessionAuthority } from "./main-desktop-session-authority";
import { createMemorySessionModes } from "./memory-session-modes";
import { createMemoryRunAuthority, type MemoryRunGrant } from "./main-memory-contracts";
import { createMainAttachmentProjectionAuthority, mainAttachmentReferences, type MainAttachmentGrant } from "./main-attachment-projection";
import { materializeTranscript, type TranscriptRunReader } from "../orchestrator/conversation-transcript-context";
import { copyResponseJson } from "../orchestrator/vendors/response-request-snapshot";
import type { TranscriptMutation } from "../orchestrator/conversation-transcript-store";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { createMainMemoryRuntime, type MainMemoryRun } from "./main-memory-runtime";
import type { BoundSourceRef } from "../../shared/memory-contracts";
import { createDefaultRunCapture } from "./default-run-capture";
import { createTemporaryRunCapture } from "./temporary-run-capture";
import { createShadowService, type ShadowService } from "../memory-shadow/shadow-service";
import { createShadowModel, type ShadowModel } from "../memory-shadow/shadow-model-call";
import {createNaturalExtractionRunner} from "../memory-policy/natural-extraction-runner";
import {NATURAL_JOB_LIMITS} from "../memory-policy/natural-automation";
import type {NaturalModelProfile, MemoryAutomationState} from "../../shared/memory-automation-contracts";
import { recordRequest, recordUsage } from "../storage/token-usage-store";
import { queryScopedHistory } from "./scoped-history-query";
import { parseHistoryTimeIntent } from "../memory-history/history-time-intent";
import { createProductionModelRegistry } from "./production-model-registry";
import { openProductionMemoryBackend, type ProductionMemoryBackend } from "./production-memory-backend";

const SCOPE = "desktop-local-profile-v1", ACTOR = "desktop-local-user-v1", PROVIDER = "desktop-chat-user-v1";
const SETTINGS_SESSION = "memory-settings-user-events-v1";
type Event = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;
type AuthorityOptions = Parameters<typeof createMainDesktopSessionAuthority>[0];
export interface DefaultMemoryHistoryCoverage {
  readonly status: "not-checked" | "complete" | "insufficient";
  readonly selected: number;
  readonly covered: number;
  readonly diagnostics: readonly string[];
  /** Absent until a query ran. Anything but `complete` means a budget cut the retrieval short, whatever `covered` says. */
  readonly retrieval?: "complete" | "index-budget-exhausted" | "excerpt-budget-exhausted";
  /** Present only when the question carried a time intent; anything but `applied` means some history had no provable time. */
  readonly temporal?: "applied" | "partial" | "unavailable";
  /** Present only when some retrieved hits are fragments of a longer conversation: fully retrieved, but partial in content. */
  readonly excerpted?: number;
}
export interface MainDefaultMemoryOptions extends Pick<AuthorityOptions, "getChatWindow" | "targets"> {
  getSettingsWindow?(): Pick<BrowserWindow, "webContents" | "isDestroyed"> | null;
  getSession(id: string): ChatSession | undefined | null;
  /** Mode and temporariness without reading the session file; owned() runs on every read check. */
  getSessionKind?(id: string): { mode: ChatSession["mode"]; temporary: boolean } | null;
  listSessionIds(): string[];
  /** Workspace info from the session index (no session files read); used to name projects in the settings list. */
  listProjectBindings?(): ReadonlyArray<{ workspaceRoot?: string; displayName?: string }>;
  store: ConversationTranscriptStore;
  /** Main-owned recovery evidence from this installed storage context only. */
  runReader?: TranscriptRunReader;
  settings(): ModelSettings;
  /** Main-only resource seam. One opener belongs to this entire storage-context owner. */
  openBackend?(): Promise<ProductionMemoryBackend>;
  clock?: () => number;
  /** IANA zone used to read "yesterday"/"last week" in a question; the system zone by default. */
  timeZone?: string;
  /** Pure status projection for the host UI. It cannot confer run/read authority. */
  onHistoryCoverage?(sessionId: string, coverage: DefaultMemoryHistoryCoverage): void;
}
/** Future trusted channel/task adapters must reuse these resources, never open another Worker. */
export interface DefaultMemorySharedResources {
  readonly backend: ProductionMemoryBackend;
  readonly actorAuthority: ReturnType<typeof createMainActorAuthority>;
  readonly registry: ReturnType<typeof createMainSourceRegistry>;
  readonly router: ReturnType<typeof createMainSourceRouter>;
  readonly models: ReturnType<typeof createProductionModelRegistry>;
  readonly sessionModes: ReturnType<typeof createMemorySessionModes>;
}
const fail = (code = "MEMORY_DESKTOP_SESSION_DENIED"): never => { throw Error(code); };

/** Ordinary desktop Chat/Work/Code composition. No renderer opt-in or diagnostic profile. */
export function createMainDefaultMemory(options: MainDefaultMemoryOptions) {
  const clock = options.clock ?? Date.now;
  const knownSessions = new Set<string>(), deletedSessions = new Set<string>();
  const ownerLifetime = new AbortController();
  const sessionModes = createMemorySessionModes();
  const attachments = createMainAttachmentProjectionAuthority();
  type AttachmentProof = { sessionId: string; userTurnId: string; revision: number; text: string; fingerprint: string };
  const attachmentProofs = new Map<string, AttachmentProof>();
  const pendingAttachmentEdits = new Map<string, Omit<AttachmentProof, "revision">>();
  const attachmentKey = (sessionId: string, userTurnId: string) => canonicalJson([sessionId, userTurnId]);
  function attachmentClaim(sessionId: string, message: ChatMessage): Omit<AttachmentProof, "revision"> | undefined {
    if (message.role !== "user" || typeof message.content !== "string" || message.modelContext || !message.attachments?.length) return undefined;
    mainAttachmentReferences(message.attachments);
    return { sessionId, userTurnId: message.id, text: message.content, fingerprint: canonicalJson(copyResponseJson(message.attachments, true)) };
  }
  function forgetAttachmentProofs(sessionId: string): void {
    for (const [key, proof] of attachmentProofs) if (proof.sessionId === sessionId) attachmentProofs.delete(key);
    for (const [key, proof] of pendingAttachmentEdits) if (proof.sessionId === sessionId) pendingAttachmentEdits.delete(key);
  }
  // A temporary session is fixed at creation and is Chat only. Its mode binding is immutable, so a
  // session can never be flipped between persistent and temporary after memory has seen it.
  const temporaryIds = new Set<string>();
  const isTemporary = (id: string) => temporaryIds.has(id) || options.getSession(id)?.temporary === true;
  function owned(id: string): boolean {
    const session = options.getSessionKind ? options.getSessionKind(id) : (() => {
      const full = options.getSession(id);
      return full && full.id === id ? { mode: full.mode, temporary: full.temporary === true } : null;
    })();
    const valid = id !== SETTINGS_SESSION && !deletedSessions.has(id) && !!session && ["chat", "work", "code"].includes(session.mode)
      && (!session.temporary || session.mode === "chat");
    if (valid) {
      knownSessions.add(id);
      if (session!.temporary) temporaryIds.add(id);
      sessionModes.bind(id, session!.temporary ? "temporary" : "persistent");
    }
    return valid;
  }
  const authority = createMainDesktopSessionAuthority({ ...options, enabled: true, allowedModes: ["chat", "work", "code"],
    scopeKey: SCOPE, actorKey: ACTOR, isControlledSession: session => owned(session.id) })!;
  const source = createDesktopUserSourceProvider({ authority, providerId: PROVIDER, scopeKey: SCOPE, clock,
    timeZone: () => options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    isOwnedSession: owned,
    readUser: identity => {
      const matches = options.getSession(identity.sessionId)?.messages.filter(message => message.id === identity.messageId);
      if (matches?.length !== 1) return null;
      const message = matches[0];
      return message.role === "user" && typeof message.content === "string" && !message.modelContext
        ? { role: "user", text: message.content } : null;
    },
    readCommittedEdit: async identity => {
      const entries = (await options.store.read(identity.sessionId)).entries;
      const entry = entries.filter(entry => entry.kind === "turn_rewind" && entry.payload.anchorUserTurnId === identity.messageId).at(-1);
      return entry?.kind === "turn_rewind" && entry.payload.disposition === "replace_user" && entry.payload.reason === "edit"
        && entry.revision && entry.payload.replacementUser
        ? { revision: entry.revision, text: entry.payload.replacementUser.text } : null;
    },
  });
  const settingsSource = createSettingsUserSourceProvider({ scopeKey: SCOPE, providerId: PROVIDER, sessionId: SETTINGS_SESSION, store: options.store, clock, signal: ownerLifetime.signal, getSettingsWindow: options.getSettingsWindow ?? (() => null) });
  const taskSource = createTaskSourceProvider({ providerId: PROVIDER, store: options.store, clock, signal: ownerLifetime.signal });
  const backgroundSessions = new Map<string, { ingress: BackgroundMemoryIngress; context: Readonly<BackgroundMemoryIngressContext>; scopeKey: string; actorKey: string; readContexts: Set<object> }>();
  const backgroundRunEntries = new Map<string, { context: Readonly<BackgroundMemoryIngressContext>; scopeKey: string; actorKey: string; profileId: string; signal: AbortSignal; revision: number; parentGrant?: MemoryRunGrant }>();
  const backgroundPrepared = new Set<{ quiesce(): void; close(): Promise<void> }>();
  const usedBackgroundRuns = new Set<string>();
  const liveRuns = new WeakMap<MainMemoryRun, { grant: MemoryRunGrant }>();
  let backgroundRevision = 0;
  const channelSource = createChannelSourceProvider({ providerId: PROVIDER, store: options.store, clock, signal: ownerLifetime.signal });
  const channelSessions = new Map<string, { ingress: ChannelMemoryIngress; context: Readonly<ChannelMemoryIngressContext> }>();
  const channelRunEntries = new Map<string, { context: Readonly<ChannelMemoryIngressContext>; profileId: string; signal: AbortSignal }>();
  const channelPrepared = new Set<{ quiesce(): void; close(): Promise<void> }>();
  const usedChannelRuns = new Set<string>();
  const channelKey = (sessionId: string, runId: string) => canonicalJson([sessionId, runId]);
  const models = createProductionModelRegistry({ settings: options.settings });
  const admissions = new Map<string, { grant: object; users: number; revision: number; controller: AbortController; signal: AbortSignal }>();
  let revision = 0, closing = false, closePromise: Promise<void> | undefined;
  type SessionRecord = { actor: object; access: object; entry: "desktop" | "channel" | "scheduler" | "proactive" | "child"; native: ReturnType<typeof createNativeHistoryProvider>; eventEpochs: Map<string, number>; releaseObserver?: () => void; active: boolean };
  const records = new Map<string, SessionRecord>();
  /** Temporary sessions hold only an in-memory actor: no native history provider, no stored state. */
  const temporaryRecords = new Map<string, { actor: object; active: boolean }>();
  const coverage = new Map<string, DefaultMemoryHistoryCoverage>();
  const opening = new Set<Promise<MainMemoryRun>>();
  const captureTargets = new Map<object, { conversationId: string; runId: string; assistantTurnId: string }>();
  const runCaptures = new Map<object, ReturnType<typeof createDefaultRunCapture>>();
  const adjustmentReleases = new Map<object, () => void>();
  // Shadow extraction (default off). Verified user sources wait here until their run succeeds.
  interface ShadowPending { sourceRef: BoundSourceRef; userTurnId: string; userText: string; profile: { id: string; revision: number } }
  const shadowPending = new Map<string, ShadowPending>();
  // Journal recovery and new calls remain owned until their actual transport settles.
  const naturalTasks = new Set<Promise<unknown>>();
  const shadowKey = (sessionId: string, runId: string) => canonicalJson([sessionId, runId]);
  let shadow: ShadowService | undefined;
  let boot: Promise<Awaited<ReturnType<typeof initialize>>> | undefined;
  let naturalRecovery:Promise<void>|undefined;
  let liveRunAuthority: ReturnType<typeof createMemoryRunAuthority> | undefined;
  let mutations: Promise<unknown> = Promise.resolve();
  function status(id: string, value: DefaultMemoryHistoryCoverage) {
    const safe = Object.freeze({ ...value, diagnostics: Object.freeze([...new Set(value.diagnostics)]) });
    coverage.set(id, safe);
    try { options.onHistoryCoverage?.(id, safe); } catch { /* UI observers do not alter authority or cleanup. */ }
  }
  /** Project key of a Work/Code session's bound workspace; Chat sessions and unbound sessions only see global facts. */
  function projectOf(id: string): string | undefined {
    const root = options.getSession(id)?.workspaceBinding?.workspaceRoot;
    return root ? projectKeyForWorkspaceRoot(root) : undefined;
  }
  function selectedProfile(id: string): string {
    const session = options.getSession(id);
    if (!session || !owned(id)) return fail();
    const settings = options.settings();
    const profileId = session.modelProfileId ?? settings.defaultModelProfileId ?? resolveDefaultModelProfile(settings.modelProfiles ?? [], undefined)?.id;
    if (!profileId || !models.profile(profileId)) return fail("MEMORY_RUN_PROFILE_DENIED");
    return profileId;
  }
  function requireAdmission(id: string) {
    const admission = admissions.get(id);
    if (closing || !admission || admission.signal.aborted || !owned(id)) return fail();
    authority.require(admission.grant, id);
    return admission;
  }
  function revokeAdmission(id: string) {
    const admission = admissions.get(id); admissions.delete(id);
    admission?.controller.abort(Error("MEMORY_RUN_REVOKED"));
  }
  const releaseDeleted = options.targets.onSessionDeleted(id => { deletedSessions.add(id); revokeAdmission(id); attachments.revokeSession(id); forgetAttachmentProofs(id); sessionModes.remove(id); temporaryRecords.delete(id); shadow?.cancelSession(id, "source-changed"); });
  function bind(event: Event, id: string) {
    if (closing || !owned(id)) return fail();
    const grant = authority.bind(event, id); source.attachSession(grant, id); return grant;
  }
  async function beforeCanonicalMutation(id: string, state: SessionRecord, kind: TranscriptMutation, entry?: TranscriptEntry, ticket?: object): Promise<void> {
    // The session observer exists before the first user append, while its S adapter is per run.
    // Preserve that live observation; reading/backfilling an old transcript never creates one.
    let epoch: number | undefined;
    if (entry && !entry.id.startsWith("backfill:v1:")) {
      const core = await boot; if (!core) return fail("MEMORY_CONTEXT_CAPTURE_UNSUPPORTED");
      const actor = core.actorAuthority.requireActor(state.actor);
      epoch = await core.actorAuthority.coordinate(() => core.backend.transport.policyCommand({ kind: "generation", scopeKey: actor.scopeKey, body: { actorKey: actor.actorKey } })) as number;
      if (!Number.isSafeInteger(epoch) || epoch < 0) return fail("MEMORY_CONTEXT_INPUT_INVALID");
    }
    if (kind === "delete" || kind === "repair") { attachments.revokeSession(id); forgetAttachmentProofs(id); }
    else if (entry?.kind === "turn_rewind") {
      attachments.revokeTurn(id, entry.payload.anchorUserTurnId);
      // Regeneration retains the exact original user selection/revision. It still
      // needs a fresh projection; only replacement edits retire that selection proof.
      if (entry.payload.disposition !== "keep_user") attachmentProofs.delete(attachmentKey(id, entry.payload.anchorUserTurnId));
    }
    else if (entry?.kind === "user" && entry.turnId) attachments.revokeTurn(id, entry.turnId);
    await state.native.beforeMutation(kind, entry, ticket);
    if (kind === "delete" || kind === "repair") state.eventEpochs.clear();
    if (epoch !== undefined && entry) state.eventEpochs.set(entry.id, epoch);
  }
  function nativeObserver(id: string, state: SessionRecord) {
    if (closing || state.active || state.releaseObserver) return;
    state.releaseObserver = options.store.observeMutations(id, (kind, entry, ticket) => beforeCanonicalMutation(id, state, kind, entry, ticket));
  }
  async function initialize() {
    const backend = await (options.openBackend ?? openProductionMemoryBackend)();
    try {
      if (closing) fail();
      const router = createMainSourceRouter({ providerId: PROVIDER });
      router.register({ scopeKey: SCOPE, anchorIdentity: { providerId: PROVIDER, sessionId: SETTINGS_SESSION, messageId: "main-actor-binding" }, sourceToken: settingsSource.token });
      sessionModes.bind(SETTINGS_SESSION, "persistent");
      const resolveActor = (scope: string, identity: { providerId: string; sessionId: string }) => {
        if (identity.providerId !== PROVIDER) return null;
        const background = backgroundSessions.get(identity.sessionId);
        if (background) {
          requireBackgroundMemoryIngress(background.ingress);
          return scope === background.scopeKey ? background.actorKey : null;
        }
        const channel = channelSessions.get(identity.sessionId);
        if (channel) {
          const current = requireChannelMemoryIngress(channel.ingress);
          return current === channel.context && current.scopeKey === scope ? current.actorKey : null;
        }
        return scope === SCOPE && (identity.sessionId === SETTINGS_SESSION || owned(identity.sessionId)) ? ACTOR : null;
      };
      const actorAuthority = createMainActorAuthority({ resolveActor });
      const registry = createMainSourceRegistry(backend.transport, { coordinate: actorAuthority.coordinate }), access = registry.authority.access(SCOPE);
      const settingsActor = actorAuthority.bindActor(access, router.token, { providerId: PROVIDER, sessionId: SETTINGS_SESSION, messageId: "main-actor-binding" });
      const policy = createMainPolicy({ registry, transport: backend.transport, actorAuthority, resolveActor });
      const recall = createMainRecall({ actorAuthority, transport: backend.transport });
      const history = createMainHistory({ actorAuthority, registry, transport: backend.transport, localRetrieval: backend.localRetrieval, onBudgetStats: createHistoryBudgetStatsRecorder(() => getStorageContext().files.historyBudgetStats).record });
      const coordinator = createMainUserFactCoordinator({ actorAuthority, registry, policy });
      const selector = createMainFactSelector({ actorAuthority, registry, policy, recall });
      const runAuthority: ReturnType<typeof createMemoryRunAuthority> = createMemoryRunAuthority({ actors: actorAuthority, sessionModes, resolveProfile: models.profile,
        resolveEntry: (identity, actor) => {
          if (["scheduler", "proactive", "child"].includes(identity.entry)) {
            const entry = backgroundRunEntries.get(channelKey(identity.sessionId, identity.runId));
            if (!entry || entry.context.entry !== identity.entry || entry.profileId !== identity.modelProfileId || actor.scopeKey !== entry.scopeKey || actor.actorKey !== entry.actorKey || actor.providerId !== PROVIDER) return null;
            entry.context.assertCurrent();
            if (entry.parentGrant) runAuthority.require(entry.parentGrant);
            return { revision: entry.revision, signal: entry.signal };
          }
          if (identity.entry === "channel") {
            const entry = channelRunEntries.get(channelKey(identity.sessionId, identity.runId));
            if (!entry || entry.profileId !== identity.modelProfileId || actor.scopeKey !== entry.context.scopeKey || actor.actorKey !== entry.context.actorKey || actor.providerId !== PROVIDER) return null;
            entry.context.assertCurrent();
            return { revision: entry.context.accountRevision, accountKey: entry.context.accountKey, signal: entry.signal };
          }
          if (identity.entry !== "desktop" || actor.scopeKey !== SCOPE || actor.actorKey !== ACTOR || actor.providerId !== PROVIDER) return null;
          const admission = requireAdmission(identity.sessionId);
          if (selectedProfile(identity.sessionId) !== identity.modelProfileId) return null;
          return { revision: admission.revision, signal: admission.signal };
        },
        canRead: (actor, target) => {
          if (actor.providerId !== PROVIDER || target.providerId !== PROVIDER || actor.scopeKey !== target.scopeKey || actor.actorKey !== target.actorKey) return false;
          const background = backgroundSessions.get(actor.sessionId);
          if (background) return background.readContexts.has(target);
          if (channelSessions.has(actor.sessionId)) return actor.sessionId === target.sessionId;
          return actor.scopeKey === SCOPE && actor.actorKey === ACTOR && (target.sessionId === SETTINGS_SESSION || owned(target.sessionId));
        },
      });
      const runtime = createMainMemoryRuntime({ actorAuthority, registry, transport: backend.transport, runAuthority, clock,
        resolveModel: grant => models.bind(runAuthority.require(grant).identity.modelProfileId),
        createTemporaryCapture: ({ run }) => {
          const id = run.identity.sessionId, state = temporaryRecords.get(id), target = captureTargets.get(run);
          if (!state || !target || !state.active) return fail("MEMORY_CONTEXT_CAPTURE_UNSUPPORTED");
          return createTemporaryRunCapture({ ...target, store: options.store, runReader: options.runReader,
            onClose: () => { state.active = false; captureTargets.delete(run); grantsByContext.delete(run); } });
        },
        createCapture: ({ context, run }) => {
          const id = run.identity.sessionId, state = records.get(id), target = captureTargets.get(run);
          const channelEntry = run.identity.entry === "channel" ? channelRunEntries.get(channelKey(id, run.identity.runId)) : undefined;
          const backgroundEntry = backgroundRunEntries.get(channelKey(id, run.identity.runId));
          const useFacts = run.identity.entry === "desktop" || channelEntry?.context.provenance === "direct-text";
          if (!state || !target || !state.active) return fail("MEMORY_CONTEXT_CAPTURE_UNSUPPORTED");
          state.releaseObserver?.(); state.releaseObserver = undefined;
          try {
            const capture = createDefaultRunCapture({ ...target, context, store: options.store, runReader: options.runReader, actorAuthority, actorToken: state.actor, registry,
              beforeMutation: (kind, entry, ticket) => beforeCanonicalMutation(id, state, kind, entry, ticket), observedEventEpochs: state.eventEpochs,
              attachmentProjection: attachments.token,
              ...(run.identity.entry === "desktop" && run.identity.sessionMode === "persistent" ? { onUserSource: (item: { sourceRef: BoundSourceRef; userTurnId: string; userText: string }) => {
                const message = options.getSession(id)?.messages.find(current => current.id === item.userTurnId);
                if (options.getSession(id)?.mode !== "chat" || !message || message.attachments?.length) return;
                const key = shadowKey(id, run.identity.runId);
                shadowPending.delete(key); shadowPending.set(key, { sourceRef: item.sourceRef, userTurnId: item.userTurnId, userText: item.userText, profile: { id: run.identity.modelProfileId, revision: run.profileRevision } });
                // Runs that never succeed leave their entry behind; keep only the newest few.
                while (shadowPending.size > 32) shadowPending.delete(shadowPending.keys().next().value!);
              } } : {}),
              summary: { protectedRecentTurns: models.bind(run.identity.modelProfileId).budget.minRecentCompleteTurns },
              ...(useFacts ? { facts: { currentUserSource: async (current: { userTurnId: string; userRevision: number }) => {
                runAuthority.require(grantsByContext.get(run)!);
                return registry.capture(state.access, router.token, { providerId: PROVIDER, sessionId: id, messageId: current.userTurnId });
              }, coordinator, selector, limits: { maxFacts: 8 } } } : {}),
              history: { query: async (current, signal) => {
                const assertCurrent = () => { runAuthority.require(grantsByContext.get(run)!); };
                assertCurrent();
                if (channelEntry) {
                  // Only this authenticated tuple's canonical S and direct M are available.
                  // ASR/quotes cannot impersonate a fresh direct user source for M selection.
                  return { tokens: [], ...(!useFacts ? { notice: "MEMORY_CHANNEL_SOURCE_LIMITED: 当前输入包含转写、引用或附件；本轮仅使用本会话上下文，不读取或维护长期记忆。" } : {}) };
                }
                const actors = run.readActorTokens.filter(token => actorAuthority.requireActor(token).sessionId !== SETTINGS_SESSION);
                status(id, { status: "not-checked", selected: actors.length, covered: 0, diagnostics: [] });
                // Only the verified current user question can carry a time intent; history text never does.
                const timeIntent = parseHistoryTimeIntent(current.userText, clock(), options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
                const result = await queryScopedHistory({ actors, assertCurrent, ...(timeIntent ? { timeIntent: { label: timeIntent.label } } : {}),
                  capture: token => {
                    const other = actorAuthority.requireActor(token), historical = records.get(other.sessionId);
                    if (!historical || historical.actor !== token || other.sessionId === id) return fail("MEMORY_ACTOR_DENIED");
                    return historical.native.capture(signal);
                  },
                  query: async covered => {
                    const partition = history.grantSessions(state.actor, covered, { includeCurrent: false });
                    // The index status travels with the evidence: an exhausted budget is a gap in the result.
                    const retrieved = await history.query(state.actor, { query: current.userText, scope: partition, signal, ...(timeIntent ? { temporal: timeIntent.query } : {}) });
                    return { evidence: retrieved.evidence, status: retrieved.status, excerpted: retrieved.hits.filter(hit => hit.document.excerpt !== undefined).length, ...(retrieved.temporal ? { temporal: retrieved.temporal } : {}) };
                  },
                });
                status(id, result.coverage);
                const notice = [result.notice, ...(backgroundEntry ? ["MEMORY_BACKGROUND_SOURCE_LIMITED: 本轮系统或模型任务指令不作为用户事实；仅使用已验证轨迹和明确继承的只读历史，未导入旧任务消息或补造历史快照。"] : [])].filter(Boolean).join("\n");
                return { tokens: result.tokens, ...(notice ? { notice } : {}) };
              } },
            });
            runCaptures.set(run, capture);
            return { ...capture, async close() {
              adjustmentReleases.get(run)?.(); adjustmentReleases.delete(run);
              try { await capture.close?.(); }
              finally { state.active = false; runCaptures.delete(run); captureTargets.delete(run); grantsByContext.delete(run); nativeObserver(id, state); }
            } };
          } catch (error) { state.active = false; nativeObserver(id, state); throw error; }
        },
      });
      liveRunAuthority = runAuthority;
      const natural=createNaturalExtractionRunner({policy,signal:ownerLifetime.signal});
      const core={ backend, actorAuthority, registry, router, access, policy, history, coordinator, selector, runAuthority, runtime, models, sessionModes, settingsActor, natural };
      return core;
    } catch (error) { await backend.close(); throw error; }
  }
  const grantsByContext = new Map<object, Parameters<ReturnType<typeof createMemoryRunAuthority>["require"]>[0]>();
  function resources(recover=true) {
    if (closing) return Promise.reject(Error("MEMORY_DESKTOP_SESSION_DENIED"));
    const ready=boot??(boot=initialize());
    if(!recover)return ready;
    return ready.then(async core=>{
      naturalRecovery??=Promise.resolve().then(async()=>{
        // Saved work is local and visible before a persistent entry's first read.
        const unsent=await recoverNatural(core,true);
        if(unsent&&!closing){const pending=Promise.resolve().then(()=>recoverNatural(core,false));naturalTasks.add(pending);void pending.finally(()=>naturalTasks.delete(pending));}
      });
      await naturalRecovery;return core;
    });
  }
  type Core=Awaited<ReturnType<typeof initialize>>;
  function recordOwned(core:Core,id:string):SessionRecord {
    if (!owned(id)) return fail();
    let state = records.get(id);
    if (!state) {
      core.router.register({ scopeKey: SCOPE, anchorIdentity: { providerId: PROVIDER, sessionId: id, messageId: "main-actor-binding" }, sourceToken: source.token });
      // The workspace binding can change during a session, so the project is looked up at each use.
      const actor = core.actorAuthority.bindActor(core.access, core.router.token, { providerId: PROVIDER, sessionId: id, messageId: "main-actor-binding" }, { project: () => projectOf(id) });
      const native = createNativeHistoryProvider({ actorAuthority: core.actorAuthority, actorToken: actor, store: options.store, history: core.history,
        endpointFactory: core.backend.endpointFactory, deadlineMs: 30000 });
      state = { actor, access: core.access, entry: "desktop", native, eventEpochs: new Map(), active: false }; records.set(id, state); nativeObserver(id, state);
    }
    return state;
  }
  async function record(id: string) {return recordOwned(await resources(),id)}
  async function naturalModel(core:Core,actor:object,id:string,liveRevision?:number):Promise<ShadowModel> {
    const binding=core.models.bind(id);if(liveRevision!==undefined&&binding.revision!==liveRevision)throw Error("MEMORY_RUN_PROFILE_CHANGED");
    const profile=await core.policy.naturalCommand<NaturalModelProfile>(actor,"profile",{profileId:id,definition:{...binding.config,window:binding.budget.maxContextTokens,timeout:options.settings().chatRequestTimeoutSec??0}},ownerLifetime.signal);
    binding.assertCurrent();
    return createShadowModel({profile,config:binding.config,adapter:binding.adapter,assertCurrent:()=>binding.assertCurrent(),
      verifiedLimits:{requestBytes:NATURAL_JOB_LIMITS.requestBytes,outputTokens:NATURAL_JOB_LIMITS.outputTokens,responseBytes:NATURAL_JOB_LIMITS.resultBytes},
      onDispatch:name=>recordRequest(name),onUsage:(name,usage)=>recordUsage(usage.input,usage.output,1,usage.cachedInput,name,usage.cacheCreation)});
  }
  async function recoverNatural(core:Core,savedOnly:boolean):Promise<boolean> {
    try{
      if(closing)return false;const phase=savedOnly?"result-saved":"unsent",jobs=await core.policy.naturalJobs(core.settingsActor,true);
      const sessions=new Set(jobs.filter(job=>job.phase===phase&&job.sourceRef.binding.providerId===PROVIDER).map(job=>job.sourceRef.binding.sessionId));
      for(const id of sessions){
        if(closing)return false;const session=options.getSession(id);
        if(!session||session.mode!=="chat"||!owned(id)||isTemporary(id)||projectOf(id)!==undefined)continue;
        const state=recordOwned(core,id);
        await core.natural.recover(state.actor,profile=>naturalModel(core,state.actor,profile.id),ownerLifetime.signal,[phase]);
      }
      return jobs.some(job=>job.phase==="unsent");
    }catch(error){console.warn("[memory-natural] recovery unavailable",error instanceof Error&&/^MEMORY_[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"unexpected");return false}
  }
  async function getShadowService(): Promise<ShadowService | undefined> {
    if (shadow) return shadow;
    if (closing) return undefined;
    const core = await resources();
    const transport = core.backend.transport;
    if (typeof transport.shadowCommand !== "function") return undefined;
    if (!shadow) {
      shadow = createShadowService({ transport: { shadowCommand: command => transport.shadowCommand!(command) }, scopeKey: SCOPE, actorKey: ACTOR,
        onError: error => console.warn("[memory-shadow] background task failed", error instanceof Error && /^MEMORY_[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "unexpected") });
      // Drop records whose source message is gone and statistics past their retention.
      void shadow.prune().catch(() => undefined);
    }
    return shadow;
  }
  function serialized<T>(operation: () => Promise<T>): Promise<T> { const pending = mutations.then(operation); mutations = pending.catch(() => undefined); return pending; }
  async function reconcile(id: string, messageId: string) {
    const core = await resources();
    try { await core.registry.reconcile(core.access, core.router.token, { providerId: PROVIDER, sessionId: id, messageId }); }
    catch (error) { if (!(error instanceof Error) || !["MEMORY_SOURCE_DELETED", "MEMORY_USER_SOURCE_DENIED", "MEMORY_SOURCE_ACCESS_DENIED"].includes(error.message)) throw error; }
  }
  /**
   * A temporary chat run: the model sees only this conversation, read from its in-memory transcript.
   * There is no source capture, fact, history or context record, so nothing is written to memory.
   */
  async function openTemporary(input: FireflyRunOptions, id: string, admission: ReturnType<typeof requireAdmission>, profileId: string,
    core: Awaited<ReturnType<typeof initialize>>, target: { conversationId: string; runId: string; assistantTurnId: string }): Promise<MainMemoryRun> {
    const identity = { providerId: PROVIDER, sessionId: id, messageId: "main-actor-binding" };
    let state = temporaryRecords.get(id);
    if (!state) {
      core.router.register({ scopeKey: SCOPE, anchorIdentity: identity, sourceToken: source.token });
      state = { actor: core.actorAuthority.bindActor(core.access, core.router.token, identity, { sessionMode: "temporary" }), active: false };
      temporaryRecords.set(id, state);
    }
    if (state.active) return fail("MEMORY_CONTEXT_RUN_ACTIVE");
    state.active = true;
    let grant: ReturnType<typeof core.runAuthority.issue> | undefined, run: ReturnType<typeof core.runAuthority.require> | undefined;
    try {
      grant = core.runAuthority.issue({ identity: { entry: "desktop", sessionId: id, runId: input.runId!, modelProfileId: profileId, sessionMode: "temporary" },
        actorToken: state.actor, sourceProvider: core.router.token, readActorTokens: [], signal: input.signal ? AbortSignal.any([input.signal, admission.signal]) : admission.signal });
      run = core.runAuthority.require(grant); captureTargets.set(run, target); grantsByContext.set(run, grant);
      const memoryRun = await core.runtime.openRun(grant);
      try { memoryRun.bindSink(input.transcriptSink!); } catch (error) { await memoryRun.close(); throw error; }
      liveRuns.set(memoryRun, { grant });
      return memoryRun;
    } catch (error) {
      if (grant) core.runAuthority.revoke(grant);
      if (run) { captureTargets.delete(run); grantsByContext.delete(run); }
      state.active = false; throw error;
    }
  }
  async function open(input: FireflyRunOptions): Promise<MainMemoryRun> {
    const id = input.conversationId; if (!id) return fail();
    const admission = requireAdmission(id);
    if (!input.runId || !input.transcriptSink) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
    const target = readTranscriptSinkBinding(input.transcriptSink, options.store);
    if (target.conversationId !== id || target.runId !== input.runId) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
    const profileId = selectedProfile(id), core = await resources(!isTemporary(id)); requireAdmission(id);
    if (sessionModes.require(id) === "temporary") return openTemporary(input, id, admission, profileId, core, target);
    const state = await record(id); if (state.active) return fail("MEMORY_CONTEXT_RUN_ACTIVE");
    state.active = true;
    let grant: ReturnType<typeof core.runAuthority.issue> | undefined, run: ReturnType<typeof core.runAuthority.require> | undefined;
    try {
      // A former H session becoming current S cannot retain a stale history publication.
      await state.native.invalidate("grant-change"); requireAdmission(id);
      // Same boundary as project facts: a session reads unbound history, plus its own project's when it has one.
      // An unbound session never reads project history, and no session reads another project's.
      const project = projectOf(id);
      const others = [...new Set(options.listSessionIds())].filter(other => other !== id && owned(other) && !isTemporary(other)
        && [undefined, project].includes(projectOf(other)) && options.getSession(other)?.messages.some(message => message.role === "user"));
      const readActorTokens: object[] = [core.settingsActor];
      for (const other of others) readActorTokens.push((await record(other)).actor);
      grant = core.runAuthority.issue({ identity: { entry: "desktop", sessionId: id, runId: input.runId, modelProfileId: profileId, sessionMode: sessionModes.require(id) },
        actorToken: state.actor, sourceProvider: core.router.token, readActorTokens, signal: input.signal ? AbortSignal.any([input.signal, admission.signal]) : admission.signal });
      run = core.runAuthority.require(grant); captureTargets.set(run, target); grantsByContext.set(run, grant);
      const memoryRun = await core.runtime.openRun(grant);
      try {
        memoryRun.bindSink(input.transcriptSink);
        if (input.pollRunAdjustments) {
          const runGrant = grant, runContext = run;
          const release = bindRunAdjustmentPoller(input.pollRunAdjustments, { sessionId: id, runId: input.runId }, (permit, commitHistory) => serialized(async () => {
            core.runAuthority.require(runGrant);
            const allowed = requireRunAdjustmentPermit(permit, { sessionId: id, runId: target.runId });
            const capture = runCaptures.get(runContext);
            if (!capture) return fail("MEMORY_RUN_ADJUSTMENT_DENIED");
            // Do not hold the source queue while validating the old S/M/H boundary:
            // validation itself acquires source leases. The adapter owns the canonical
            // queue here, and the owner serializes this against desktop edits.
            return capture.commitRunAdjustment(permit, () => source.mutate(() => {
              core.runAuthority.require(runGrant);
              const ticket = source.prepareUserCommit(admission.grant, id, allowed.turnId);
              let message;
              try { message = commitHistory(); }
              catch (error) {
                try { source.cancelUserCommit(ticket); } catch { /* Never undo written/unknown metadata. */ }
                throw error;
              }
              if (message.id !== allowed.turnId || message.rawContent !== allowed.text) return fail("MEMORY_RUN_ADJUSTMENT_DENIED");
              source.finishUserCommit(ticket);
              return message;
            }));
          }));
          adjustmentReleases.set(run, release);
        }
      } catch (error) { await memoryRun.close(); throw error; }
      liveRuns.set(memoryRun, { grant });
      return memoryRun;
    } catch (error) {
      if (grant) core.runAuthority.revoke(grant);
      if (run) { captureTargets.delete(run); grantsByContext.delete(run); }
      state.active = false; nativeObserver(id, state); throw error;
    }
  }
  const channelHost: ChannelsMemoryHost = Object.freeze({
    prepareRun(input: Parameters<ChannelsMemoryHost["prepareRun"]>[0]): Promise<ChannelMemoryPreparedRun> {
      return serialized(async () => {
        if (closing) return fail("MEMORY_CONTEXT_RUNTIME_CLOSED");
        const context = requireChannelMemoryIngress(input.ingress, input.message);
        const selectedAttachments = channelMemoryAttachments(input.message);
        if (context.provenance === "source-less" || input.userText !== formatChannelUserText(input.message)) return fail("MEMORY_CHANNEL_SOURCE_DENIED");
        const runId = parseInternalId(input.runId), userTurnId = parseInternalId(input.userTurnId), assistantTurnId = parseInternalId(input.assistantTurnId);
        const profileId = parseInternalId(input.modelProfileId);
        if (!models.profile(profileId)) return fail("MEMORY_RUN_PROFILE_DENIED");
        if (userTurnId === assistantTurnId) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
        if (input.signal?.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
        const key = channelKey(context.sessionId, runId);
        if (usedChannelRuns.has(key)) return fail("MEMORY_CONTEXT_RUN_REUSED");
        const core = await resources(); context.assertCurrent();
        let state = records.get(context.sessionId);
        if (state?.active) return fail("MEMORY_CONTEXT_RUN_ACTIVE");
        const attached = channelSource.attach(input.ingress, input.message);
        channelSessions.set(context.sessionId, { ingress: input.ingress, context: attached });
        sessionModes.bind(context.sessionId, "persistent");
        if (!state) {
          const access = core.registry.authority.access(context.scopeKey);
          core.router.register({ scopeKey: context.scopeKey, anchorIdentity: { providerId: PROVIDER, sessionId: context.sessionId, messageId: "main-actor-binding" }, sourceToken: channelSource.token });
          const actor = core.actorAuthority.bindActor(access, core.router.token, { providerId: PROVIDER, sessionId: context.sessionId, messageId: "main-actor-binding" });
          const native = createNativeHistoryProvider({ actorAuthority: core.actorAuthority, actorToken: actor, store: options.store, history: core.history, endpointFactory: core.backend.endpointFactory, deadlineMs: 30000 });
          state = { actor, access, native, eventEpochs: new Map(), entry: "channel", active: false }; records.set(context.sessionId, state); nativeObserver(context.sessionId, state);
        }
        if (state.entry !== "channel") return fail("MEMORY_ACTOR_DENIED");
        const channelState = state, controller = new AbortController();
        const signal = AbortSignal.any([ownerLifetime.signal, context.signal, controller.signal, ...(input.signal ? [input.signal] : [])]);
        channelState.active = true;
        let attachmentGrant: MainAttachmentGrant | undefined;
        try {
          await channelSource.commitUserEvent(input.ingress, { message: input.message, messageId: userTurnId, text: input.userText });
          context.assertCurrent(); if (signal.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
          if (selectedAttachments.length) attachmentGrant = attachments.issue({ sessionId: context.sessionId, userTurnId, userRevision: 1, userText: input.userText,
            attachments: selectedAttachments, signal, assertCurrent: () => { requireChannelMemoryIngress(input.ingress, input.message); } });
        } catch (error) { channelState.active = false; throw error; }
        usedChannelRuns.add(key);
        const transcriptSink = createTranscriptSink({ store: options.store, conversationId: context.sessionId, runId, assistantTurnId });
        channelRunEntries.set(key, { context, profileId, signal });
        let stopped = false, openAttempted = false, run: MainMemoryRun | undefined, openingRun: Promise<MainMemoryRun> | undefined, closed: Promise<void> | undefined;
        const lifecycle = {
          quiesce() { if (stopped) return; stopped = true; controller.abort(); },
          close(): Promise<void> {
            if (closed) return closed;
            closed = Promise.resolve().then(async () => {
              await openingRun?.catch(() => undefined);
              try { await run?.close(); }
              finally { channelState.active = false; channelRunEntries.delete(key); channelPrepared.delete(lifecycle); nativeObserver(context.sessionId, channelState); }
            });
            lifecycle.quiesce(); return closed;
          },
        };
        channelPrepared.add(lifecycle);
        return Object.freeze({ sessionId: context.sessionId, signal, transcriptSink, ...(attachmentGrant ? { attachmentGrant } : {}),
          openMemoryRun(current: FireflyRunOptions): Promise<MainMemoryRun> {
            if (openAttempted) return Promise.reject(Error("MEMORY_CONTEXT_RUN_REUSED"));
            openAttempted = true;
            openingRun = (async () => {
              if (stopped || closing || signal.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
              requireChannelMemoryIngress(input.ingress, input.message);
              if (current.conversationId !== context.sessionId || current.runId !== runId || !current.transcriptSink) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
              const target = readTranscriptSinkBinding(current.transcriptSink, options.store);
              if (target.conversationId !== context.sessionId || target.runId !== runId || target.assistantTurnId !== assistantTurnId) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
              const grant = core.runAuthority.issue({ identity: { entry: "channel", sessionId: context.sessionId, runId, modelProfileId: profileId, sessionMode: "persistent" }, actorToken: channelState.actor,
                sourceProvider: core.router.token, readActorTokens: [], signal: current.signal ? AbortSignal.any([signal, current.signal]) : signal });
              const runContext = core.runAuthority.require(grant); captureTargets.set(runContext, target); grantsByContext.set(runContext, grant);
              try {
                run = await core.runtime.openRun(grant); run.bindSink(current.transcriptSink); liveRuns.set(run, { grant }); return run;
              } catch (error) {
                core.runAuthority.revoke(grant);
                if (run) await run.close();
                captureTargets.delete(runContext); grantsByContext.delete(runContext); throw error;
              }
            })();
            return openingRun;
          },
          close: () => lifecycle.close(),
        });
      });
    },
  });
  async function recoverInterruptedChild(context: BackgroundMemoryIngressContext, previousRunId: string, currentRunId: string, signal?: AbortSignal): Promise<void> {
    const assertRecoveryCurrent = () => {
      if (closing || ownerLifetime.signal.aborted) return fail("MEMORY_CONTEXT_RUNTIME_CLOSED");
      if (signal?.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
      context.assertCurrent();
    };
    assertRecoveryCurrent();
    if (context.entry !== "child" || previousRunId === currentRunId) return fail("MEMORY_CHILD_RECOVERY_DENIED");
    const requirePrevious = () => {
      const previous = options.runReader?.get(previousRunId);
      if (!previous) return fail("MEMORY_CHILD_RECOVERY_EVIDENCE_UNAVAILABLE");
      if (previous.runId !== previousRunId || previous.conversationId !== context.sessionId) return fail("MEMORY_CHILD_RECOVERY_IDENTITY_MISMATCH");
      if (previous.status !== "running" && previous.status !== "interrupted") return fail("MEMORY_CHILD_RECOVERY_NOT_INTERRUPTED");
      return previous;
    };
    const previous = requirePrevious(), snapshot = await options.store.read(context.sessionId);
    assertRecoveryCurrent(); requirePrevious();
    const assistants = snapshot.entries.filter(entry => entry.kind === "assistant" && entry.runId === previousRunId);
    if (!assistants.length && previous.toolCalls.length) return fail("MEMORY_CHILD_RECOVERY_BINDING_MISMATCH");
    const declared = new Map<string, string>();
    for (const entry of assistants) {
      if (entry.kind !== "assistant" || entry.turnId !== `${previousRunId}-assistant`) return fail("MEMORY_CHILD_RECOVERY_BINDING_MISMATCH");
      for (const call of entry.payload.toolCalls ?? []) declared.set(call.id, call.name);
    }
    if (previous.toolCalls.some(call => declared.get(call.toolCallId) !== call.toolName)) return fail("MEMORY_CHILD_RECOVERY_BINDING_MISMATCH");
    const instruction = snapshot.entries.find(entry => entry.kind === "user" && entry.turnId === `${previousRunId}-instruction`);
    if (!instruction || instruction.kind !== "user" || instruction.payload.text !== previous.messages.find(message => message.role === "user")?.content) return fail("MEMORY_CHILD_RECOVERY_BINDING_MISMATCH");
    // Use the accepted canonical closer. The fresh ingress/owner fence applies to
    // each append; no former source capability or history snapshot is restored.
    const sink = createTranscriptSink({ store: options.store, conversationId: context.sessionId, runId: previousRunId, assistantTurnId: `${previousRunId}-assistant` });
    await sink.closeInterruption({ reason: "user_cancel", runSession: previous, assertCurrent: () => { assertRecoveryCurrent(); requirePrevious(); }, createGuard: throughSeq => ({
      throughSeq,
      validate: async () => { assertRecoveryCurrent(); requirePrevious(); },
      commit: async write => { assertRecoveryCurrent(); requirePrevious(); return write(); },
    }) });
    assertRecoveryCurrent();
  }
  const backgroundHost: BackgroundMemoryHost = Object.freeze({
    prepareBackgroundRun(input: Parameters<BackgroundMemoryHost["prepareBackgroundRun"]>[0]): Promise<BackgroundMemoryPreparedRun> {
      return serialized(async () => {
        if (closing) return fail("MEMORY_CONTEXT_RUNTIME_CLOSED");
        const context = requireBackgroundMemoryIngress(input.ingress);
        if (context.instructionText !== input.instructionText) return fail("MEMORY_BACKGROUND_INGRESS_DENIED");
        if (context.sessionId === SETTINGS_SESSION || owned(context.sessionId) || channelSessions.has(context.sessionId)) return fail("MEMORY_ACTOR_DENIED");
        const runId = parseInternalId(input.runId), userTurnId = parseInternalId(input.userTurnId), assistantTurnId = parseInternalId(input.assistantTurnId), profileId = parseInternalId(input.modelProfileId);
        if (!models.profile(profileId)) return fail("MEMORY_RUN_PROFILE_DENIED");
        if (userTurnId === assistantTurnId) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
        if (input.signal?.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
        let parentGrant: MemoryRunGrant | undefined;
        if (input.readParentGrant !== undefined) {
          if (context.entry !== "child") return fail("MEMORY_RUN_READ_DENIED");
          parentGrant = liveRuns.get(input.readParentGrant)?.grant;
          if (!parentGrant || !liveRunAuthority) return fail("MEMORY_RUN_READ_DENIED");
          try { liveRunAuthority.require(parentGrant); } catch { return fail("MEMORY_RUN_READ_DENIED"); }
        }
        const key = channelKey(context.sessionId, runId);
        if (usedBackgroundRuns.has(key)) return fail("MEMORY_CONTEXT_RUN_REUSED");
        const core = await resources(); context.assertCurrent();
        const parent = parentGrant ? core.runAuthority.require(parentGrant) : undefined;
        const parentActor = parent ? core.actorAuthority.requireActor(parent.actorToken) : undefined;
        const identityHash = createHash("sha256").update(canonicalJson([context.entry, context.sourceKey, context.sessionId])).digest("hex");
        const scopeKey = parentActor?.scopeKey ?? `background-scope-${identityHash}`, actorKey = parentActor?.actorKey ?? `background-actor-${identityHash}`;
        const readActorTokens = parent ? [...new Set([parent.actorToken, ...parent.readActorTokens])] : [];
        const previous = backgroundSessions.get(context.sessionId);
        if (previous && (previous.scopeKey !== scopeKey || previous.actorKey !== actorKey || previous.context.sourceKey !== context.sourceKey || previous.context.entry !== context.entry)) return fail("MEMORY_RUN_READ_DENIED");
        let state = records.get(context.sessionId); if (state?.active) return fail("MEMORY_CONTEXT_RUN_ACTIVE");
        if (state && !["scheduler", "proactive", "child"].includes(state.entry)) return fail("MEMORY_ACTOR_DENIED");
        if (input.recoverRunId !== undefined) await recoverInterruptedChild(context, parseInternalId(input.recoverRunId), runId, input.signal);
        context.assertCurrent(); if (closing || ownerLifetime.signal.aborted) return fail("MEMORY_CONTEXT_RUNTIME_CLOSED");
        taskSource.attach(input.ingress, scopeKey);
        backgroundSessions.set(context.sessionId, { ingress: input.ingress, context, scopeKey, actorKey, readContexts: new Set(readActorTokens.map(token => core.actorAuthority.requireActor(token))) });
        sessionModes.bind(context.sessionId, "persistent");
        if (!state) {
          const access = core.registry.authority.access(scopeKey);
          core.router.register({ scopeKey, anchorIdentity: { providerId: PROVIDER, sessionId: context.sessionId, messageId: "main-actor-binding" }, sourceToken: taskSource.token });
          const actor = core.actorAuthority.bindActor(access, core.router.token, { providerId: PROVIDER, sessionId: context.sessionId, messageId: "main-actor-binding" });
          const native = createNativeHistoryProvider({ actorAuthority: core.actorAuthority, actorToken: actor, store: options.store, history: core.history, endpointFactory: core.backend.endpointFactory, deadlineMs: 30000 });
          state = { actor, access, native, eventEpochs: new Map(), entry: context.entry, active: false }; records.set(context.sessionId, state); nativeObserver(context.sessionId, state);
        }
        const backgroundState = state, controller = new AbortController();
        const signal = AbortSignal.any([ownerLifetime.signal, context.signal, controller.signal, ...(parent ? [parent.signal] : []), ...(input.signal ? [input.signal] : [])]);
        backgroundState.active = true;
        try {
          const identity = await taskSource.commitInstruction(input.ingress, { messageId: userTurnId, instructionText: input.instructionText, scopeKey });
          context.assertCurrent(); if (signal.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
          // Persist only the real system/model provenance; wire user is turn framing.
          await core.registry.capture(backgroundState.access, core.router.token, identity);
          context.assertCurrent(); if (signal.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
        } catch (error) { backgroundState.active = false; throw error; }
        usedBackgroundRuns.add(key);
        const transcriptSink = createTranscriptSink({ store: options.store, conversationId: context.sessionId, runId, assistantTurnId });
        backgroundRunEntries.set(key, { context, scopeKey, actorKey, profileId, signal, revision: ++backgroundRevision, ...(parentGrant ? { parentGrant } : {}) });
        let stopped = false, openAttempted = false, run: MainMemoryRun | undefined, openingRun: Promise<MainMemoryRun> | undefined, closed: Promise<void> | undefined;
        const lifecycle = {
          quiesce() { if (stopped) return; stopped = true; controller.abort(); },
          close(): Promise<void> {
            if (closed) return closed;
            closed = Promise.resolve().then(async () => {
              await openingRun?.catch(() => undefined);
              try { await run?.close(); }
              finally { backgroundState.active = false; backgroundRunEntries.delete(key); backgroundPrepared.delete(lifecycle); nativeObserver(context.sessionId, backgroundState); }
            });
            lifecycle.quiesce(); return closed;
          },
        };
        backgroundPrepared.add(lifecycle);
        return Object.freeze({ sessionId: context.sessionId, signal, transcriptSink,
          openMemoryRun(current: FireflyRunOptions): Promise<MainMemoryRun> {
            if (openAttempted) return Promise.reject(Error("MEMORY_CONTEXT_RUN_REUSED"));
            openAttempted = true;
            openingRun = (async () => {
              if (stopped || closing || signal.aborted) return fail("MEMORY_CONTEXT_CANCELLED");
              requireBackgroundMemoryIngress(input.ingress);
              if (current.conversationId !== context.sessionId || current.runId !== runId || !current.transcriptSink) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
              const target = readTranscriptSinkBinding(current.transcriptSink, options.store);
              if (target.conversationId !== context.sessionId || target.runId !== runId || target.assistantTurnId !== assistantTurnId) return fail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
              const grant = core.runAuthority.issue({ identity: { entry: context.entry, sessionId: context.sessionId, runId, modelProfileId: profileId, sessionMode: "persistent" }, actorToken: backgroundState.actor,
                sourceProvider: core.router.token, readActorTokens, signal: current.signal ? AbortSignal.any([signal, current.signal]) : signal });
              const runContext = core.runAuthority.require(grant); captureTargets.set(runContext, target); grantsByContext.set(runContext, grant);
              try {
                run = await core.runtime.openRun(grant, { createModelExecutionObserver: input.createModelExecutionObserver }); run.bindSink(current.transcriptSink); liveRuns.set(run, { grant }); return run;
              } catch (error) {
                core.runAuthority.revoke(grant); if (run) await run.close();
                captureTargets.delete(runContext); grantsByContext.delete(runContext); throw error;
              }
            })();
            return openingRun;
          },
          close: () => lifecycle.close(),
        });
      });
    },
  });
  function parseSettingsAction(value: unknown): MemoryPanelAction {
    const input = objectFields(value, ["kind", "id", "expectedRevision"], ["text", "contentHash"]);
    if (!["confirm", "reject", "correct", "forget"].includes(input.kind as string)) return fail("MEMORY_INPUT_INVALID");
    const result: MemoryPanelAction = { kind: input.kind as MemoryPanelAction["kind"], id: parseInternalId(input.id), expectedRevision: positiveRevision(input.expectedRevision) };
    if (input.contentHash !== undefined) {
      if (result.kind !== "confirm" || typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)) return fail("MEMORY_INPUT_INVALID");
      result.contentHash = input.contentHash;
    }
    if (result.kind === "correct" || input.text !== undefined) {
      if (result.kind !== "correct" && result.kind !== "confirm") return fail("MEMORY_INPUT_INVALID");
      result.text = textField(input.text);
    }
    return result;
  }
  async function allCandidates(core: Awaited<ReturnType<typeof initialize>>) {
    const items: Awaited<ReturnType<typeof core.policy.candidates>>["items"] = [];
    let cursor: object | null = null;
    do { const page = await core.policy.candidates(core.settingsActor, { limit: 100, ...(cursor ? { cursor } : {}) }); items.push(...page.items); cursor = page.cursor; } while (cursor);
    return items;
  }
  const settingsActions = new Map<string, Promise<Awaited<ReturnType<MemorySettingsHost["applyAction"]>>>>();
  function settingsGrant(event: IpcMainInvokeEvent) { if (closing) return fail("MEMORY_CLOSED"); return settingsSource.authorize(event); }
  const automationHost: MemoryAutomationSettingsHost = Object.freeze({
    async state(event: IpcMainInvokeEvent): Promise<MemoryAutomationState> {
      const grant = settingsGrant(event);
      try { return await serialized(async () => {
        settingsSource.require(grant); const core = await resources(); settingsSource.require(grant);
        const state = await core.policy.naturalCommand<Omit<MemoryAutomationState, "available">>(core.settingsActor, "state");
        settingsSource.require(grant); return { ...state, available: true };
      }); } finally { settingsSource.release(grant); }
    },
    async configure(event: IpcMainInvokeEvent, value: unknown): Promise<MemoryAutomationState> {
      const input = parseMemoryAutomationConfigure(value), grant = settingsGrant(event);
      try { return await serialized(async () => {
        settingsSource.require(grant); const core = await resources(); settingsSource.require(grant);
        const current = await core.policy.naturalCommand<Omit<MemoryAutomationState, "available">>(core.settingsActor, "state"); settingsSource.require(grant);
        if (current.config.revision !== input.expectedRevision) return fail("MEMORY_REVISION_CONFLICT");
        const identity = await settingsSource.commitUserEvent(grant, { messageId: `settings-${randomUUID()}`, text: naturalConsentStatement(input.expectedRevision, input.language, input.responseStyle) });
        const sourceRef = await core.registry.capture(core.access, core.router.token, identity); settingsSource.require(grant);
        // The closure stays in Main and runs at actual dispatch, after asynchronous source re-reading.
        const state = await core.policy.naturalCommand<Omit<MemoryAutomationState, "available">>(core.settingsActor, "configure", { ...input, sourceRef }, ownerLifetime.signal, () => settingsSource.require(grant));
        settingsSource.require(grant); return { ...state, available: true };
      }); } finally { settingsSource.release(grant); }
    },
  });
  const settingsHost: MemorySettingsHost = Object.freeze({
    async getState(event: IpcMainInvokeEvent): Promise<MemoryPanelState> {
      const grant = settingsGrant(event);
      try { return await serialized(async () => {
        settingsSource.require(grant); const core = await resources(); settingsSource.require(grant);
        const recalled = await core.policy.manage(core.settingsActor), pending = await allCandidates(core); settingsSource.require(grant);
        const needed = new Set([...recalled, ...pending].flatMap(item => item.projectKey === undefined ? [] : [item.projectKey]));
        // Names are decoration: resolved only for the projects shown, best effort, never able to fail the panel.
        const names = resolveProjectNames(needed, { listSessionIds: () => options.listSessionIds(), getSession: id => options.getSession(id), ...(options.listProjectBindings ? { listProjectBindings: () => options.listProjectBindings!() } : {}) });
        // Conversation titles are decoration too (the memory graph shows where a fact came from): best effort, never failing the panel.
        const titleOf = (sourceRef: { binding?: { sessionId?: string } }): string | undefined => {
          try { const title = sourceRef.binding?.sessionId ? options.getSession(sourceRef.binding.sessionId)?.title : undefined; return typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : undefined; }
          catch { return undefined; }
        };
        const place = <T extends { projectKey?: string; sourceRef: { binding?: { sessionId?: string } } }>(item: T): Omit<T, "projectKey"> & { projectName?: string; sourceTitle?: string } => {
          const { projectKey, ...rest } = item;
          const projectName = projectKey === undefined ? undefined : names.get(projectKey), sourceTitle = titleOf(item.sourceRef);
          return { ...rest, ...(projectName ? { projectName } : {}), ...(sourceTitle ? { sourceTitle } : {}) };
        };
        const facts = recalled.map(place);
        const candidates = pending.map(item => ({ ...place(item), scope: item.projectKey === undefined ? "global" as const : "project" as const }));
        return { facts, candidates, backendStatus: { available: true }, coverage: { status: "not-measured", reason: "MEMORY_HISTORY_COVERAGE_NOT_MEASURED", population: null, present: null, missing: null, unknownDenied: null, exactRatio: null, lowerRatio: null, upperRatio: null, reasons: {}, evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: null, ratio: null } } };
      }); } finally { settingsSource.release(grant); }
    },
    async applyAction(event: IpcMainInvokeEvent, value: MemoryPanelAction) {
      const grant = settingsGrant(event);
      let action: MemoryPanelAction;
      try { action = parseSettingsAction(value); } catch (error) { settingsSource.release(grant); throw error; }
      const key = canonicalJson(action), existing = settingsActions.get(key);
      if (existing) { settingsSource.release(grant); return existing; }
      const pending = serialized(async () => {
        settingsSource.require(grant); const core = await resources(); settingsSource.require(grant);
        let assertion = "";
        if (action.kind === "confirm" || action.kind === "reject") {
          const selected = (await allCandidates(core)).find(candidate => candidate.candidateId === action.id);
          if (!selected) return fail("MEMORY_CANDIDATE_NOT_FOUND");
          if (selected.revision !== action.expectedRevision) return fail("MEMORY_REVISION_CONFLICT");
          if (action.kind === "confirm") {
            if (selected.reviewState !== "ready" || !selected.assertion.trim()) return fail("MEMORY_POLICY_UNRESOLVED");
            if (!action.contentHash || action.contentHash !== selected.contentHash) return fail("MEMORY_CONFIRMATION_STALE");
          }
          assertion = selected.assertion;
        } else {
          const selected = await core.policy.audit(core.settingsActor, action.id);
          if (selected.revision === null) return fail("MEMORY_FACT_NOT_FOUND");
          if (selected.revision !== action.expectedRevision) return fail("MEMORY_REVISION_CONFLICT");
        }
        settingsSource.require(grant);
        const nonce = randomUUID(); let sourceRef: import("../../shared/memory-contracts").BoundSourceRef | undefined;
        if (action.kind === "confirm" || action.kind === "correct") {
          const text = action.kind === "correct" ? action.text! : `I confirm the selected memory (${action.id}, revision ${action.expectedRevision}): ${assertion}${action.text ? "\n" + action.text : ""}`;
          const extraction = extractPreference(text);
          if (extraction.kind === "rejected") return fail("MEMORY_POLICY_SECRET");
          if (action.kind === "correct") await core.policy.validateCorrection(core.settingsActor, action.id, action.expectedRevision, text);
          const identity = await settingsSource.commitUserEvent(grant, { messageId: `settings-${nonce}`, text });
          sourceRef = await core.registry.capture(core.access, core.router.token, identity); settingsSource.require(grant);
        }
        const policyEvent = await core.policy.event(core.settingsActor, { kind: action.kind, nonce,
          ...(action.kind === "confirm" || action.kind === "reject" ? { candidateId: action.id } : { factId: action.id }),
          revision: action.expectedRevision, ...(sourceRef ? { sourceRef } : {}), ...(action.contentHash ? { contentHash: action.contentHash } : {}) });
        settingsSource.require(grant);
        return core.policy.act(core.settingsActor, policyEvent);
      });
      settingsActions.set(key, pending);
      try { return await pending; } finally { if (settingsActions.get(key) === pending) settingsActions.delete(key); settingsSource.release(grant); }
    },
    async auditSource(event: IpcMainInvokeEvent, factId: string): Promise<MemoryPanelSourceAudit> {
      const grant = settingsGrant(event);
      try { return await serialized(async () => {
        settingsSource.require(grant); const id = parseInternalId(factId), core = await resources(); settingsSource.require(grant);
        const audit = await core.policy.audit(core.settingsActor, id); settingsSource.require(grant);
        return { factId: audit.factId, revision: audit.revision, status: audit.status, reason: audit.reason,
          sources: [...audit.supports.map(support => ({ sourceId: support.sourceRef.sourceId, revision: support.sourceRef.revision, kind: support.kind, validity: support.validity, occurredAt: null })),
            ...audit.reviews.map(review => ({ sourceId: review.sourceRef.sourceId, revision: review.sourceRef.revision, kind: "review" as const, validity: "recorded", occurredAt: null }))] };
      }); } finally { settingsSource.release(grant); }
    },
  });
  /** For the chat window's memory card: how many confirmed and pending memories per category, and from how many
   * conversations. Counts only; the memory text stays with the settings window. */
  async function graphSummary(): Promise<MemoryGraphSummary> {
    if (closing) return { available: false, categories: [], sources: 0 };
    try { return await serialized(async () => {
      const core = await resources();
      const facts = await core.policy.manage(core.settingsActor), pending = (await allCandidates(core)).filter(item => item.reviewState === "ready" && item.assertion.trim());
      const counts = new Map<string, { facts: number; pending: number }>(), sessions = new Set<string>();
      const count = (attribute: string | undefined, field: "facts" | "pending", sourceRef: { binding?: { sessionId?: string } }) => {
        const key = memoryGraphCategory(attribute), entry = counts.get(key) ?? { facts: 0, pending: 0 };
        entry[field]++; counts.set(key, entry);
        if (sourceRef.binding?.sessionId) sessions.add(sourceRef.binding.sessionId);
      };
      for (const fact of facts) count(fact.typed?.legacyAttribute ?? fact.attribute, "facts", fact.sourceRef);
      for (const item of pending) count(item.attribute, "pending", item.sourceRef);
      return { available: true, categories: [...counts].map(([key, value]) => ({ key, ...value })), sources: sessions.size };
    }); } catch { return { available: false, categories: [], sources: 0 }; }
  }
  const owner = {
    settingsHost, automationHost, channelHost, backgroundHost, prepareBackgroundRun: backgroundHost.prepareBackgroundRun, graphSummary,
    usesCanonicalUserContent: true as const,
    /** Honours a session's temporary mode: zero memory writes, no M/H, no cross-session reads. */
    supportsTemporarySessions: true as const,
    /** 默认 S/M/H 接管全部会话，旧历史向量索引不再写入；受控模式只管辖部分会话，没有此标记。 */
    retiresLegacyHistoryIndex: true as const,
    prepareAttachmentGrant(event: Event, id: string, input: { userTurnId: string }): Promise<MainAttachmentGrant | undefined> {
      return serialized(async () => {
        const grant = bind(event, id), admission = requireAdmission(id);
        if (grant !== admission.grant) return fail("MEMORY_ATTACHMENT_DENIED");
        const userTurnId = parseInternalId(input.userTurnId);
        const matches = options.getSession(id)?.messages.filter(message => message.id === userTurnId);
        if (matches?.length !== 1 || matches[0].role !== "user" || typeof matches[0].content !== "string" || matches[0].modelContext) return fail("MEMORY_ATTACHMENT_DENIED");
        const message = matches[0];
        if (!message.attachments?.length) return undefined;
        if (isTemporary(id)) return fail("MEMORY_ATTACHMENT_DENIED");
        const selected = copyResponseJson(message.attachments, true) as PendingChatAttachment[];
        const references = mainAttachmentReferences(selected), storedFingerprint = canonicalJson(selected), userText = message.content;
        // A text receipt authenticates text only. File access additionally requires this
        // process's exact authenticated append/edit attachment selection, including scope.
        const proof = attachmentProofs.get(attachmentKey(id, userTurnId));
        if (!proof || proof.text !== userText || proof.fingerprint !== storedFingerprint) return fail("MEMORY_ATTACHMENT_DENIED");
        const core = await resources(); await record(id); requireAdmission(id);
        const sourceRef = await core.registry.capture(core.access, core.router.token, { providerId: PROVIDER, sessionId: id, messageId: userTurnId });
        const verified = core.registry.resolveVerifiedSource(sourceRef);
        if (verified.kind !== "user" || verified.sourceTrust !== "direct-user-event" || verified.scopeKey !== SCOPE) return fail("MEMORY_USER_SOURCE_DENIED");
        const snapshot = await options.store.read(id);
        const active = materializeTranscript(snapshot.entries, { get: () => null }).messageSources?.filter(entry => entry.turnId === userTurnId && (entry.kind === "user" || entry.kind === "turn_rewind"));
        if (active?.length !== 1) return fail("MEMORY_ATTACHMENT_DENIED");
        const canonical = active[0], payload = canonical.kind === "user" ? canonical.payload : canonical.kind === "turn_rewind" ? canonical.payload.replacementUser : undefined;
        if (!payload?.attachments?.length || payload.text !== userText || canonical.revision !== sourceRef.binding.contentRevision || canonical.revision !== proof.revision
          || canonicalJson(mainAttachmentReferences(payload.attachments)) !== canonicalJson(references)) return fail("MEMORY_ATTACHMENT_DENIED");
        const assertCurrent = () => {
          if (attachmentProofs.get(attachmentKey(id, userTurnId)) !== proof) return fail("MEMORY_ATTACHMENT_DENIED");
          if (requireAdmission(id) !== admission || authority.require(grant, id).signal.aborted) return fail("MEMORY_ATTACHMENT_DENIED");
          const users = options.getSession(id)?.messages.filter(current => current.id === userTurnId);
          const current = users?.length === 1 ? users[0] : undefined;
          if (!current || current.role !== "user" || current.modelContext || current.content !== userText || !current.attachments?.length
            || canonicalJson(copyResponseJson(current.attachments, true)) !== storedFingerprint) return fail("MEMORY_ATTACHMENT_DENIED");
        };
        assertCurrent();
        return attachments.issue({ sessionId: id, userTurnId, userRevision: canonical.revision!, userText, attachments: selected, assertCurrent, signal: admission.signal });
      });
    },
    ownsSession: (id: string) => owned(id) || knownSessions.has(id),
    refresh() { authority.refresh(); },
    /** Revalidate saved profile revisions synchronously after a real settings change.
     * require() revokes only drifted grants; unchanged/unrelated profiles stay live. */
    refreshModels(): void {
      if (!liveRunAuthority || closing) return;
      for (const grant of grantsByContext.values()) {
        try { liveRunAuthority.require(grant); }
        catch { /* The genuine run authority aborts invalid grants before throwing. */ }
      }
    },
    getHistoryCoverage(id: string): DefaultMemoryHistoryCoverage { return coverage.get(id) ?? Object.freeze({ status: "not-checked", selected: 0, covered: 0, diagnostics: Object.freeze([]) }); },
    authorizeRun(event: Event, id: string) {
      const grant = bind(event, id), binding = authority.require(grant, id);
      let admission = admissions.get(id);
      if (admission?.signal.aborted) { revokeAdmission(id); admission = undefined; }
      if (admission && admission.grant !== grant) return fail();
      if (!admission) {
        const controller = new AbortController();
        admission = { grant, users: 0, revision: ++revision, controller, signal: AbortSignal.any([binding.signal, controller.signal]) }; admissions.set(id, admission);
      }
      const state = admission; state.users++; let released = false;
      return Object.freeze({ signal: state.signal, release() { if (released) return; released = true; if (--state.users === 0 && admissions.get(id) === state) revokeAdmission(id); } });
    },
    afterTranscript(id: string, input: { userTurnId?: string; transcriptRewind?: { disposition: string } }) {
      if (input.transcriptRewind?.disposition === "replace_user") shadow?.cancelSession(id, "source-changed");
      return serialized(async () => {
      if (!owned(id) || isTemporary(id)) return;
      const admission = requireAdmission(id);
      if (input.transcriptRewind?.disposition === "replace_user" && input.userTurnId) {
        await source.commitUserEdit(admission.grant, id, input.userTurnId);
        const core = await resources(); await record(id);
        const ref = await core.registry.capture(core.access, core.router.token, { providerId: PROVIDER, sessionId: id, messageId: input.userTurnId });
        const key = attachmentKey(id, input.userTurnId), pending = pendingAttachmentEdits.get(key);
        if (pending) {
          const users = options.getSession(id)?.messages.filter(message => message.id === input.userTurnId);
          const current = users?.length === 1 ? attachmentClaim(id, users[0]) : undefined;
          if (!current || current.text !== pending.text || current.fingerprint !== pending.fingerprint) return fail("MEMORY_ATTACHMENT_DENIED");
          attachmentProofs.set(key, { ...pending, revision: ref.binding.contentRevision }); pendingAttachmentEdits.delete(key);
        }
      }
      });
    },
    appendUser<T>(event: Event, id: string, message: ChatMessage, commit: () => T): Promise<T> {
      return serialized(async () => {
        const grant = bind(event, id);
        if (isTemporary(id)) {
          // No source capture or ledger entry: a temporary message is never a memory source.
          if (message.attachments?.length) return fail("MEMORY_TEMPORARY_ATTACHMENT_UNSUPPORTED");
          if (message.role !== "user" || !message.id || typeof message.content !== "string" || message.modelContext) return fail("MEMORY_USER_SOURCE_DENIED");
          authority.require(grant, id);
          return commit();
        }
        if (message.attachments?.length) mainAttachmentReferences(message.attachments);
        if (message.role !== "user" || !message.id || typeof message.content !== "string" || message.modelContext) return fail("MEMORY_USER_SOURCE_DENIED");
        const approvedAttachment = attachmentClaim(id, message);
        const core = await resources(); await record(id); authority.require(grant, id);
        await records.get(id)?.native.invalidate("append");
        const result = await source.mutate(() => {
          const ticket = source.prepareUserCommit(grant, id, message.id);
          let value: T;
          try { value = commit(); }
          catch (error) {
            // A sync failure with no committed metadata can retry. A written or unknown
            // outcome keeps its reservation and can never be rolled back here.
            try { source.cancelUserCommit(ticket); } catch { /* Preserve the original failure. */ }
            throw error;
          }
          if (value === false) { source.cancelUserCommit(ticket); return value; }
          source.finishUserCommit(ticket);
          if (approvedAttachment) {
            const users = options.getSession(id)?.messages.filter(current => current.id === message.id);
            const current = users?.length === 1 ? attachmentClaim(id, users[0]) : undefined;
            if (!current || current.text !== approvedAttachment.text || current.fingerprint !== approvedAttachment.fingerprint) return fail("MEMORY_ATTACHMENT_DENIED");
            attachmentProofs.set(attachmentKey(id, message.id), { ...approvedAttachment, revision: 1 });
          }
          return value;
        });
        if (result !== false) await core.registry.capture(core.access, core.router.token, { providerId: PROVIDER, sessionId: id, messageId: message.id });
        return result;
      });
    },
    mutate<T>(event: Event, id: string, changedUsers: string[], commit: () => T): Promise<T> {
      return serialized(async () => {
        if (!owned(id) && !knownSessions.has(id)) return fail();
        if (changedUsers.length) shadow?.cancelSession(id, "source-changed");
        const active = options.targets.getActive(); if (!active) return fail();
        const grant = bind(event, active.sessionId);
        if (isTemporary(id)) {
          // Nothing of a temporary conversation is in the source ledger, so there is nothing to retire there.
          if (changedUsers.length) revokeAdmission(id);
          authority.require(grant, active.sessionId);
          return commit();
        }
        const core = await resources();
        if (owned(id)) await record(id);
        for (const messageId of new Set(changedUsers)) {
          attachments.revokeTurn(id, messageId); attachmentProofs.delete(attachmentKey(id, messageId)); pendingAttachmentEdits.delete(attachmentKey(id, messageId));
        }
        for (const messageId of new Set(changedUsers)) await core.registry.prepareIdentityChange(core.access, core.router.token, { providerId: PROVIDER, sessionId: id, messageId });
        if (changedUsers.length) { revokeAdmission(id); await records.get(id)?.native.invalidate("history-remove"); }
        authority.require(grant, active.sessionId);
        const result = await source.mutate(() => {
          const value = commit();
          if (value !== false) for (const messageId of new Set(changedUsers)) {
            const users = options.getSession(id)?.messages.filter(message => message.id === messageId);
            const proof = users?.length === 1 ? attachmentClaim(id, users[0]) : undefined;
            if (proof) pendingAttachmentEdits.set(attachmentKey(id, messageId), proof);
          }
          return value;
        });
        for (const messageId of new Set(changedUsers)) await reconcile(id, messageId); return result;
      });
    },
    /** The one shadow extraction service (settings page and background tasks share it); undefined if this backend has no shadow storage. */
    getShadowService,
    /** Desktop turn finished successfully: queue its user message for shadow extraction. Never throws into the chat. */
    async onTurnSucceeded(input: { sessionId: string; runId: string }): Promise<void> {
      const key = shadowKey(input.sessionId, input.runId), item = shadowPending.get(key); shadowPending.delete(key);
      if (!item || closing) return;
      try {
        const session = options.getSession(input.sessionId);
        if (!session || session.mode !== "chat" || !owned(input.sessionId) || isTemporary(input.sessionId)) return;
        const core = await resources();
        // Fixed to the model this run was admitted with; a later profile change cancels the task.
        let model: ShadowModel;
        try {
          const binding = core.models.bind(item.profile.id);
          model = createShadowModel({ profile: item.profile, config: binding.config, adapter: binding.adapter,
            assertCurrent: () => { binding.assertCurrent(); if (binding.revision !== item.profile.revision) throw new Error("MEMORY_RUN_PROFILE_CHANGED"); },
            onDispatch: name => recordRequest(name),
            onUsage: (name, usage) => recordUsage(usage.input, usage.output, 1, usage.cachedInput, name, usage.cacheCreation) });
        } catch {
          model = { profile: item.profile, assertCurrent: () => { throw new Error("MEMORY_RUN_PROFILE_CHANGED"); }, prepare: () => ({ ok: false, reason: "no-output-limit" }) };
        }
        const state = records.get(input.sessionId);
        if (state) {
          const task = naturalModel(core,state.actor,item.profile.id,item.profile.revision).then(current=>core.natural.run(state.actor,item.sourceRef,current,ownerLifetime.signal));
          naturalTasks.add(task);
          try { await task; } catch (error) {
            console.warn("[memory-natural] extraction unavailable", error instanceof Error && /^MEMORY_[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "unexpected");
          } finally { naturalTasks.delete(task); }
        }
        if (closing || !owned(input.sessionId)) return;
        const service = await getShadowService();
        if (!service) return;
        // The assistant reply right before this user message is context only, never evidence.
        const index = session.messages.findIndex(message => message.id === item.userTurnId);
        const previous = index > 0 ? session.messages[index - 1] : undefined;
        const usable = previous?.role === "model" && typeof previous.content === "string" && previous.content.trim() && !previous.modelContext
          && !previous.content.startsWith("[此前对话已压缩");
        service.submit({ sessionId: input.sessionId, sourceRef: item.sourceRef, model,
          turn: { user: { id: item.userTurnId, text: item.userText }, ...(usable ? { previousAssistant: { id: previous.id, text: previous.content } } : {}) } });
      } catch { /* Shadow extraction is optional and must not affect the chat. */ }
    },
    openRun(input: FireflyRunOptions): Promise<MainMemoryRun> {
      const pending = open(input); opening.add(pending); void pending.then(() => opening.delete(pending), () => opening.delete(pending)); return pending;
    },
    quiesce() {
      if (closing) return; closing = true; shadow?.close(); shadowPending.clear(); ownerLifetime.abort(Error("MEMORY_CONTEXT_RUNTIME_CLOSED")); attachments.quiesce(); attachmentProofs.clear(); pendingAttachmentEdits.clear(); authority.dispose(); releaseDeleted();
      for (const id of admissions.keys()) revokeAdmission(id);
      for (const prepared of channelPrepared) prepared.quiesce();
      for (const prepared of backgroundPrepared) prepared.quiesce();
      void boot?.then(core => {core.natural.quiesce();core.runtime.quiesce()}, () => undefined);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      // Publish before aborting: a synchronous abort listener may reenter close().
      closePromise = Promise.resolve().then(async () => {
        await Promise.allSettled([mutations, ...opening, ...naturalTasks, ...(naturalRecovery?[naturalRecovery]:[])]);
        const core = await boot?.catch(() => undefined);
        if (!core) { await attachments.close(); await settingsSource.close(); await channelSource.close(); await taskSource.close(); models.close(); return; }
        const failures: unknown[] = [];
        try { await core.natural.close(); } catch (error) { failures.push(error); }
        const channels = await Promise.allSettled([...channelPrepared, ...backgroundPrepared].map(prepared => prepared.close()));
        for (const result of channels) if (result.status === "rejected") failures.push(result.reason);
        try { await core.runtime.close(); } catch (error) { failures.push(error); }
        const settled = await Promise.allSettled([...records.values()].map(async state => { state.releaseObserver?.(); state.releaseObserver = undefined; await state.native.close(); }));
        for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
        try { await core.router.close(); await settingsSource.close(); await channelSource.close(); await taskSource.close(); } catch (error) { failures.push(error); }
        try { await attachments.close(); } catch (error) { failures.push(error); }
        try { await core.backend.close(); } catch (error) { failures.push(error); }
        models.close();
        if (failures.length) throw new AggregateError(failures, "MEMORY_DEFAULT_CLEANUP_FAILED");
      });
      owner.quiesce();
      return closePromise;
    },
  };
  return Object.freeze(owner);
}
export type MainDefaultMemory = ReturnType<typeof createMainDefaultMemory>;
