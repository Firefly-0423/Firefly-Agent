import type { FireflyRunOptions } from "../orchestrator/firefly-agent";
import type { TranscriptSink } from "../orchestrator/transcript-sink";
import type { MainMemoryRunOptions, MainMemoryRun } from "./main-memory-runtime";

export type BackgroundMemoryEntry = "scheduler" | "proactive" | "child";
declare const ingressBrand: unique symbol;
export type BackgroundMemoryIngress = Readonly<{ [ingressBrand]: true }>;
export interface BackgroundMemoryIngressContext {
  readonly entry: BackgroundMemoryEntry;
  readonly sessionId: string;
  readonly sourceKey: string;
  readonly instructionText: string;
  readonly sourceTrust: "system" | "model";
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface BackgroundMemoryPreparedRun {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly transcriptSink: TranscriptSink;
  openMemoryRun(options: FireflyRunOptions): Promise<MainMemoryRun>;
  close(): Promise<void>;
}
/** Main composition reuses its one backend and canonical store. No DTO grants reads. */
export interface BackgroundMemoryHost {
  prepareBackgroundRun(input: {
    ingress: BackgroundMemoryIngress;
    modelProfileId: string;
    runId: string;
    userTurnId: string;
    assistantTurnId: string;
    instructionText: string;
    /** Main child continuation only; the host resolves real installed recovery evidence. */
    recoverRunId?: string;
    signal?: AbortSignal;
    /** Only the host's own private live-run mapping may recognize this capability. */
    readParentGrant?: MainMemoryRun;
    /** Trusted observer factory, separate from the wire instruction and source/read grant. */
    createModelExecutionObserver?: MainMemoryRunOptions["createModelExecutionObserver"];
  }): Promise<BackgroundMemoryPreparedRun>;
}
const records = new WeakMap<object, Readonly<BackgroundMemoryIngressContext>>();
const denied = (): never => { throw Error("MEMORY_BACKGROUND_INGRESS_DENIED"); };
function validId(value: string): boolean {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
export function requireBackgroundMemoryIngress(value: unknown): Readonly<BackgroundMemoryIngressContext> {
  const record = value && typeof value === "object" ? records.get(value) : undefined;
  if (!record) return denied();
  record.assertCurrent();
  return record;
}
/** Kept in the producer closure. Capturing a system instruction confers no user identity. */
export function createBackgroundMemoryIngressIssuer(options: {
  entry: BackgroundMemoryEntry;
  isCurrent(source: object): boolean;
}) {
  const { entry, isCurrent } = options;
  if (!["scheduler", "proactive", "child"].includes(entry) || typeof isCurrent !== "function") denied();
  return Object.freeze({
    capture(input: { source: object; sessionId: string; sourceKey: string; instructionText: string; signal: AbortSignal }): BackgroundMemoryIngress {
      const { source, sessionId, sourceKey, instructionText, signal } = input;
      if (!source || typeof source !== "object" || !validId(sessionId) || !validId(sourceKey)
        || typeof instructionText !== "string" || !instructionText.trim() || !(signal instanceof AbortSignal)) return denied();
      const context = Object.freeze({ entry, sessionId, sourceKey, instructionText,
        sourceTrust: entry === "child" ? "model" as const : "system" as const, signal,
        assertCurrent() { if (signal.aborted || !isCurrent(source)) denied(); },
      });
      context.assertCurrent();
      const token = Object.freeze({}) as BackgroundMemoryIngress;
      records.set(token, context);
      return token;
    },
  });
}
