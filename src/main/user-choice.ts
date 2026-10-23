import { IPC } from "../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "./application/ipc-scope";
import type { AskCardPayload, AskCardSubmission, AskClarificationCard, AskUserAnswer, } from "../shared/ask-clarification";
import { publishAskCard, resolveAskCardSubmission, validateAskUserAnswer, } from "./orchestrator/ask-card";
import { getTimeoutSettings } from "./timeout-manager";
import { createAbortError } from "./abort-utils";
import { toastEvents } from "./toast/toast-events";
const CHOICE_LOG = "[UserChoice]";
export type ChoiceOption = {
    label: string;
    value: string;
    description?: string;
};
export type LegacyChoiceCardData = {
    id: string;
    question: string;
    options: ChoiceOption[];
    default?: string;
};
export type ChoiceCardData = LegacyChoiceCardData | AskCardPayload;
export type ChoiceSettlementReason = "answered" | "timeout" | "unavailable" | "cancelled";
export type ChoiceSettlement = {
    id: string;
    revision: number;
    reason: ChoiceSettlementReason;
    runId?: string;
};
type PendingChoice = {
    timer: NodeJS.Timeout;
    status: "open" | "resolving";
    resolve: (submittedValue: unknown) => boolean;
    reject?: (error: Error) => void;
    onSettled?: (outcome: ChoiceSettlement) => void;
    revision?: number;
    runId?: string;
};
const awaitingAnswers = new Map<string, PendingChoice>();
let requestSequence = 0;
let deliverCard: ((promptCard: ChoiceCardData) => void) | null = null;
let deliverSettlement: ((outcome: ChoiceSettlement) => void) | null = null;
export function setChoiceCardSender(deliver: (promptCard: ChoiceCardData) => void): void {
    deliverCard = deliver;
}
export function setChoiceDismissSender(deliver: (outcome: ChoiceSettlement) => void): void {
    deliverSettlement = deliver;
}
function toastIdentity(promptCard: ChoiceCardData): {
    cardId: string;
    intro: string;
} {
    return "interactionId" in promptCard
        ? { cardId: promptCard.interactionId, intro: promptCard.intro }
        : { cardId: promptCard.id, intro: promptCard.question };
}
const nextInteractionKey = (): string => "choice-" + (++requestSequence) + "-" + Date.now();
export type ChoiceScope = {
    runId?: string;
    signal?: AbortSignal;
};
function sendLegacySettlement(interactionKey: string, cardRevision: number, settlementReason: ChoiceSettlementReason): void {
    deliverSettlement?.({ id: interactionKey, revision: cardRevision, reason: settlementReason });
    toastEvents.publishChoiceDismiss({ cardId: interactionKey, revision: cardRevision, reason: settlementReason });
}
export function requestUserChoice(questionText: string, candidates: ChoiceOption[], fallbackAnswer?: string, ownership?: ChoiceScope): Promise<string> {
    return new Promise<string>((fulfill, fail) => {
        const interactionKey = nextInteractionKey();
        const waitDuration = getTimeoutSettings().userChoiceTimeout;
        if (ownership?.signal?.aborted) {
            fail(createAbortError());
            return;
        }
        let removeCancellation: () => void = () => undefined;
        const expiry = setTimeout(() => {
            removeCancellation();
            awaitingAnswers.delete(interactionKey);
            console.warn(CHOICE_LOG, "选择超时（" + waitDuration + "ms），使用默认值:", fallbackAnswer ?? "(空)");
            sendLegacySettlement(interactionKey, 1, "timeout");
            fulfill(fallbackAnswer ?? "");
        }, waitDuration);
        awaitingAnswers.set(interactionKey, {
            timer: expiry,
            status: "open",
            revision: 1,
            runId: ownership?.runId,
            reject: fail,
            resolve: (submittedValue) => {
                removeCancellation();
                fulfill(typeof submittedValue === "string" ? submittedValue : fallbackAnswer ?? "");
                toastEvents.publishChoiceDismiss({ cardId: interactionKey, revision: 1, reason: "answered" });
                return true;
            },
            onSettled: ({ id: settledKey, revision: cardRevision, reason: settlementReason }) => {
                removeCancellation();
                sendLegacySettlement(settledKey, cardRevision, settlementReason);
            },
        });
        const cancellation = ownership?.signal;
        if (cancellation) {
            const cancelRequest = (): void => {
                const pending = awaitingAnswers.get(interactionKey);
                if (!pending || pending.status !== "open")
                    return;
                clearTimeout(pending.timer);
                awaitingAnswers.delete(interactionKey);
                pending.onSettled?.({ id: interactionKey, runId: ownership.runId, revision: 1, reason: "cancelled" });
                fail(createAbortError());
            };
            cancellation.addEventListener("abort", cancelRequest, { once: true });
            removeCancellation = () => cancellation.removeEventListener("abort", cancelRequest);
        }
        const message: ChoiceCardData = { id: interactionKey, question: questionText, options: candidates, default: fallbackAnswer };
        console.log(CHOICE_LOG, "发送选择请求:", interactionKey, questionText);
        if (!deliverCard) {
            clearTimeout(expiry);
            removeCancellation();
            awaitingAnswers.delete(interactionKey);
            console.warn(CHOICE_LOG, "未注入卡片回调，使用默认值");
            fulfill(fallbackAnswer ?? "");
            return;
        }
        deliverCard(message);
        toastEvents.publishChoiceCard({ ...toastIdentity(message), revision: 1 });
    });
}
export function requestUserClarification(promptCard: AskClarificationCard, deliver?: (promptCard: ChoiceCardData) => void, afterSettlement?: (outcome: ChoiceSettlement) => void, runIdentity: {
    runId: string;
    revision: number;
} = { runId: "legacy", revision: 1 }): Promise<AskUserAnswer> {
    return new Promise<AskUserAnswer>((fulfill, fail) => {
        const interactionKey = nextInteractionKey();
        const emptyAnswer: AskUserAnswer = { requestId: interactionKey, answers: [] };
        const waitDuration = getTimeoutSettings().userChoiceTimeout;
        const publishedCard = publishAskCard(promptCard, { interactionId: interactionKey, ...runIdentity });
        const announceSettlement = (outcome: ChoiceSettlement): void => {
            afterSettlement?.(outcome);
            const { id: cardId, runId: executionId, revision: cardRevision, reason: settlementReason } = outcome;
            toastEvents.publishChoiceDismiss({ cardId, runId: executionId, revision: cardRevision, reason: settlementReason });
        };
        const expiry = setTimeout(() => {
            const pending = awaitingAnswers.get(interactionKey);
            if (!pending || pending.status !== "open")
                return;
            awaitingAnswers.delete(interactionKey);
            console.warn(CHOICE_LOG, "澄清超时（" + waitDuration + "ms）");
            announceSettlement({ id: interactionKey, ...runIdentity, reason: "timeout" });
            fulfill(emptyAnswer);
        }, waitDuration);
        awaitingAnswers.set(interactionKey, {
            timer: expiry,
            status: "open",
            revision: runIdentity.revision,
            runId: runIdentity.runId,
            reject: fail,
            onSettled: announceSettlement,
            resolve: (submittedValue) => {
                try {
                    const candidate = submittedValue as Record<string, unknown> | null;
                    const hasInteractionId = candidate && typeof candidate === "object" && "interactionId" in candidate;
                    const validatedAnswer = hasInteractionId ? resolveAskCardSubmission(publishedCard, submittedValue as AskCardSubmission)
                        : validateAskUserAnswer(promptCard, interactionKey, submittedValue as AskUserAnswer);
                    fulfill(validatedAnswer);
                    announceSettlement({ id: interactionKey, ...runIdentity, reason: "answered" });
                    return true;
                }
                catch {
                    return false;
                }
            },
        });
        console.log(CHOICE_LOG, "发送结构化澄清:", interactionKey);
        const sendCard = deliver ?? deliverCard;
        if (!sendCard) {
            clearTimeout(expiry);
            awaitingAnswers.delete(interactionKey);
            console.warn(CHOICE_LOG, "未注入卡片回调，返回空澄清");
            announceSettlement({ id: interactionKey, ...runIdentity, reason: "unavailable" });
            fulfill(emptyAnswer);
            return;
        }
        sendCard(publishedCard.payload);
        toastEvents.publishChoiceCard({
            ...toastIdentity(publishedCard.payload),
            runId: runIdentity.runId,
            revision: runIdentity.revision,
        });
    });
}
type ChoiceResolvePayload = {
    id: string;
    value?: string;
    answer?: AskUserAnswer | AskCardSubmission;
};
export function registerChoiceIpc(scopeOverride?: IpcScope): void {
    const scope = scopeOverride ?? createIpcScope();
    scope.handle(IPC.CHOICE_RESOLVE, (_ipcEvent, message: ChoiceResolvePayload) => {
        const pending = awaitingAnswers.get(message?.id);
        if (!pending || pending.status !== "open") {
            console.warn(CHOICE_LOG, "选择回传未匹配到 pending:", message?.id);
            return { ok: false };
        }
        pending.status = "resolving";
        const response = message.answer ?? message.value ?? "";
        console.log(CHOICE_LOG, "用户回答 payload:", JSON.stringify({
            id: message.id,
            hasAnswer: !!message.answer,
            valueType: typeof message.value,
            resolved: JSON.stringify(response).slice(0, 200),
        }));
        if (!pending.resolve(response)) {
            pending.status = "open";
            console.warn(CHOICE_LOG, "用户选择校验失败:", message.id);
            return { ok: false };
        }
        clearTimeout(pending.timer);
        awaitingAnswers.delete(message.id);
        console.log(CHOICE_LOG, "用户选择:", message.id);
        return { ok: true };
    });
}
export function cancelPendingChoicesForRun(executionId: string): void {
    for (const [interactionKey, pending] of awaitingAnswers) {
        if (pending.runId !== executionId || pending.status !== "open")
            continue;
        clearTimeout(pending.timer);
        awaitingAnswers.delete(interactionKey);
        pending.onSettled?.({ id: interactionKey, runId: executionId, revision: pending.revision ?? 1, reason: "cancelled" });
        pending.reject?.(createAbortError());
        console.log(CHOICE_LOG, "cancelPendingChoicesForRun 清理:", interactionKey, "runId=", executionId);
    }
}
