import type { IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { FactView, SourceRef } from "../../shared/memory-contracts";
import type { MemoryPanelAction, MemoryPanelOutcome, MemoryPanelSourceAudit, MemoryPanelState } from "../../shared/memory-panel-contracts";
import { objectFields, parseInternalId, positiveRevision, textField } from "../memory-core/command-validation";

/** Main-only host closes over the owner's opaque policy/source capabilities.
 * applyAction must persist an independent settings user event for confirm/correct,
 * then use policy.event/act with the transaction's revision check. */
export interface MemorySettingsHost {
  getState(event: IpcMainInvokeEvent): Promise<MemoryPanelState>;
  applyAction(event: IpcMainInvokeEvent, action: MemoryPanelAction): Promise<MemoryPanelOutcome>;
  auditSource(event: IpcMainInvokeEvent, factId: string): Promise<MemoryPanelSourceAudit>;
}
export interface MemorySettingsWindow {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; readonly mainFrame: unknown };
}
interface Options {
  getSettingsWindow(): MemorySettingsWindow | null | undefined;
  host: MemorySettingsHost | null;
}
const safeReasons = new Set([
  "MEMORY_SETTINGS_FORBIDDEN", "MEMORY_INPUT_INVALID", "MEMORY_REVISION_CONFLICT",
  "MEMORY_CANDIDATE_NOT_FOUND", "MEMORY_FACT_NOT_FOUND", "MEMORY_BACKEND_UNAVAILABLE",
  "MEMORY_SETTINGS_FAILED", "MEMORY_POLICY_UNRESOLVED", "MEMORY_POLICY_SECRET",
  "MEMORY_CONFIRMATION_NOT_INDEPENDENT", "MEMORY_POLICY_SUPPRESSED", "MEMORY_POLICY_FUTURE",
  "MEMORY_CONFIRMATION_STALE", "MEMORY_FACT_CONFLICT",
  "MEMORY_SOURCE_INVALID", "MEMORY_SOURCE_STALE", "MEMORY_SOURCE_PENDING", "MEMORY_SOURCE_DELETED",
  "MEMORY_ACTOR_DENIED", "MEMORY_EVENT_DENIED", "MEMORY_USER_SOURCE_DENIED",
  "MEMORY_POLICY_TEMPORARY_UNSUPPORTED", "MEMORY_POLICY_CANCELLED", "MEMORY_CLOSED",
  "MEMORY_KEY_PROTECTION_UNAVAILABLE", "MEMORY_HISTORY_NATIVE_UNAVAILABLE", "MEMORY_BACKEND_CLOSED",
  "MEMORY_CLIENT_CLOSED", "MEMORY_QUEUE_FULL", "MEMORY_STORAGE_INVALID", "MEMORY_WORKER_FAILED",
  "MEMORY_WORKER_TIMEOUT", "MEMORY_WRITER_LOCK_LOST", "MEMORY_KEY_INVALID",
]);
function failureReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return safeReasons.has(code) ? code : "MEMORY_SETTINGS_FAILED";
}
function unavailable(reason = "MEMORY_BACKEND_UNAVAILABLE"): MemoryPanelState {
  return { facts: [], candidates: [], backendStatus: { available: false, reason }, coverage: {
    status: "not-measured", reason, population: null, present: null, missing: null, unknownDenied: null,
    exactRatio: null, lowerRatio: null, upperRatio: null, reasons: {},
    evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: null, ratio: null },
  } };
}
function parseAction(value: unknown): MemoryPanelAction {
  const input = objectFields(value, ["kind", "id", "expectedRevision"], ["text", "contentHash"]);
  if (!["confirm", "reject", "correct", "forget"].includes(input.kind as string)) throw new Error("MEMORY_INPUT_INVALID");
  const action: MemoryPanelAction = { kind: input.kind as MemoryPanelAction["kind"], id: parseInternalId(input.id), expectedRevision: positiveRevision(input.expectedRevision) };
  if (input.contentHash !== undefined) {
    if (action.kind !== "confirm" || typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)) throw Error("MEMORY_INPUT_INVALID");
    action.contentHash = input.contentHash;
  }
  if (action.kind === "correct" || input.text !== undefined) {
    if (!["correct", "confirm"].includes(action.kind)) throw new Error("MEMORY_INPUT_INVALID");
    action.text = textField(input.text);
  }
  return action;
}
/** Whitelist output properties, including nested provenance: never serialize host objects. */
function source(ref: SourceRef): SourceRef {
  return { sourceId: ref.sourceId, revision: ref.revision, ...(ref.span ? { span: { start: ref.span.start, end: ref.span.end } } : {}),
    ...(ref.binding ? { binding: { providerId: ref.binding.providerId, sessionId: ref.binding.sessionId, messageId: ref.binding.messageId, contentRevision: ref.binding.contentRevision, generation: ref.binding.generation } } : {}) };
}
function fact(item: FactView): FactView {
  return { factId: item.factId, revision: item.revision, subjectKey: item.subjectKey, assertion: item.assertion, assertionKind: item.assertionKind,
    time: { validFrom: item.time.validFrom, validTo: item.time.validTo, referenceTime: item.time.referenceTime }, sourceRef: source(item.sourceRef),
    recordedAt: item.recordedAt, acceptedAt: item.acceptedAt, supersededAt: item.supersededAt, activationReason: item.activationReason, policyVersion: item.policyVersion,
    provenance: { candidateId: item.provenance.candidateId, evidenceId: item.provenance.evidenceId, activationSourceRef: source(item.provenance.activationSourceRef) },
    ...(item.scope === "global" || item.scope === "project" ? { scope: item.scope } : {}),
    ...(typeof item.projectName === "string" && item.projectName ? { projectName: item.projectName.slice(0, 200) } : {}),
    ...(item.typed?.legacyAttribute ? { attribute: item.typed.legacyAttribute } : {}),
    ...(typeof item.sourceTitle === "string" && item.sourceTitle ? { sourceTitle: item.sourceTitle.slice(0, 200) } : {}) };
}
function stateDto(state: MemoryPanelState): MemoryPanelState {
  const c = state.coverage;
  return { facts: state.facts.map(fact), candidates: state.candidates.map((item) => ({ candidateId: item.candidateId, revision: item.revision, attribute: item.attribute,
    reviewState: item.reviewState === "ready" && item.assertion.trim() ? "ready" : "reference-only",
    ...(item.time ? { time: { validFrom: item.time.validFrom, validTo: item.time.validTo, referenceTime: item.time.referenceTime } } : {}),
    value: item.value, assertion: item.assertion, reason: item.reason, sourceRef: source(item.sourceRef), ...(item.occurredAt !== undefined ? { occurredAt: item.occurredAt } : {}),
      ...(typeof item.contentHash === "string" && /^[a-f0-9]{64}$/.test(item.contentHash) ? { contentHash: item.contentHash } : {}),
      ...(item.scope === "global" || item.scope === "project" ? { scope: item.scope } : {}),
      ...(typeof item.projectName === "string" && item.projectName ? { projectName: item.projectName.slice(0, 200) } : {}),
      ...(typeof item.sourceTitle === "string" && item.sourceTitle ? { sourceTitle: item.sourceTitle.slice(0, 200) } : {}) })),
    backendStatus: { available: state.backendStatus.available, ...(state.backendStatus.reason ? { reason: state.backendStatus.reason } : {}) },
    coverage: { status: c.status, ...(c.reason ? { reason: c.reason } : {}), population: c.population, present: c.present, missing: c.missing, unknownDenied: c.unknownDenied,
      exactRatio: c.exactRatio, lowerRatio: c.lowerRatio, upperRatio: c.upperRatio, reasons: { ...c.reasons }, evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: c.evidence.unknown, ratio: null } } };
}
function outcomeDto(result: MemoryPanelOutcome): MemoryPanelOutcome {
  return { status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.candidateId ? { candidateId: result.candidateId } : {}),
    ...(result.candidateRevision !== undefined ? { candidateRevision: result.candidateRevision } : {}), ...(result.factId ? { factId: result.factId } : {}), ...(result.factRevision !== undefined ? { factRevision: result.factRevision } : {}) };
}
export function createMemorySettingsIpc(options: Options) {
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new WeakMap<object, Map<string, Promise<MemoryPanelOutcome>>>();
  function authorize(event: IpcMainInvokeEvent): void {
    const win = options.getSettingsWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) throw new Error("MEMORY_SETTINGS_FORBIDDEN");
  }
  async function getMemoryPanelState(event: IpcMainInvokeEvent): Promise<MemoryPanelState> {
    authorize(event);
    if (!options.host) return unavailable();
    try { const result = stateDto(await options.host.getState(event)); authorize(event); return result; }
    catch (error) { if (failureReason(error) === "MEMORY_SETTINGS_FORBIDDEN") throw new Error("MEMORY_SETTINGS_FORBIDDEN"); return unavailable(failureReason(error)); }
  }
  async function applyMemoryPanelAction(event: IpcMainInvokeEvent, value: unknown): Promise<MemoryPanelOutcome> {
    let action: MemoryPanelAction;
    try { authorize(event); action = parseAction(value); } catch (error) { return { status: "rejected", reason: failureReason(error) }; }
    const key = JSON.stringify(action);
    let requests = pending.get(event.sender);
    if (!requests) { requests = new Map(); pending.set(event.sender, requests); }
    const existing = requests.get(key);
    if (existing) return existing;
    const operation = queue.then(async (): Promise<MemoryPanelOutcome> => {
      try {
        authorize(event);
        if (!options.host) throw new Error("MEMORY_BACKEND_UNAVAILABLE");
        const state = await options.host.getState(event);
        authorize(event);
        if (!state.backendStatus.available) throw new Error("MEMORY_BACKEND_UNAVAILABLE");
        const candidateAction = action.kind === "confirm" || action.kind === "reject";
        const target = candidateAction ? state.candidates.find((item) => item.candidateId === action.id) : state.facts.find((item) => item.factId === action.id);
        if (!target) throw new Error(candidateAction ? "MEMORY_CANDIDATE_NOT_FOUND" : "MEMORY_FACT_NOT_FOUND");
        if (target.revision !== action.expectedRevision) throw new Error("MEMORY_REVISION_CONFLICT");
        if (action.kind === "confirm") {
          if (!("reviewState" in target) || target.reviewState !== "ready" || !target.assertion.trim()) throw Error("MEMORY_POLICY_UNRESOLVED");
          if (!action.contentHash || !("contentHash" in target) || target.contentHash !== action.contentHash) throw Error("MEMORY_CONFIRMATION_STALE");
        }
        const result = await options.host.applyAction(event, action);
        authorize(event);
        return outcomeDto(result);
      } catch (error) { return { status: "rejected", reason: failureReason(error) }; }
    });
    requests.set(key, operation);
    queue = operation.then(() => undefined, () => undefined);
    void operation.finally(() => { if (requests!.get(key) === operation) requests!.delete(key); });
    return operation;
  }
  async function auditMemoryPanelSource(event: IpcMainInvokeEvent, value: unknown): Promise<MemoryPanelSourceAudit> {
    try {
      authorize(event);
      const id = parseInternalId(value);
      if (!options.host) throw new Error("MEMORY_BACKEND_UNAVAILABLE");
      const audit = await options.host.auditSource(event, id);
      authorize(event);
      return { factId: audit.factId, revision: audit.revision, status: audit.status, reason: audit.reason,
        sources: audit.sources.map((item) => ({ sourceId: item.sourceId, revision: item.revision, kind: item.kind, validity: item.validity, occurredAt: item.occurredAt })) };
    } catch (error) { throw new Error(failureReason(error)); }
  }
  return { getMemoryPanelState, applyMemoryPanelAction, auditMemoryPanelSource };
}
export function registerMemorySettingsIpc(options: Options & { ipc: { handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void } }) {
  const handlers = createMemorySettingsIpc(options);
  options.ipc.handle(IPC.MEMORY_PANEL_GET_STATE, handlers.getMemoryPanelState);
  options.ipc.handle(IPC.MEMORY_PANEL_APPLY_ACTION, handlers.applyMemoryPanelAction);
  options.ipc.handle(IPC.MEMORY_PANEL_AUDIT_SOURCE, handlers.auditMemoryPanelSource);
  return handlers;
}
