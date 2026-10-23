import { isTaskEnabled } from "./execution-spec";
import { computeNextFireAtAfter, normalizeOverdueNextFireAt } from "./schedule-calculator";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";
const MAX_WAKE_INTERVAL = 60 * 60 * 1000;
interface SchedulerStoreLike {
    assertHistoryReady?(): void;
    getTasks(): ScheduledTask[];
    updateTask(makeHistoryId: string, patch: Partial<ScheduledTask>): ScheduledTask;
    recordHistory(entry: ScheduledTaskHistoryEntry): void;
    onChange(listener: (tasks: ScheduledTask[]) => void): () => void;
}
export interface SchedulerEngineDeps {
    store: SchedulerStoreLike;
    runTask: (job: ScheduledTask, appointment: Date, requestedByUser: boolean) => Promise<ScheduledRunResult>;
    canRunTask?: (job: ScheduledTask) => boolean;
    now?: () => Date;
    id?: () => string;
}
function makeRunHistoryKey(): string {
    return `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
export class SchedulerEngine {
    private wakeTimer: NodeJS.Timeout | null = null;
    private activeJobs = new Set<string>();
    private readonly instant: () => Date;
    private readonly makeHistoryId: () => string;
    private detachStore?: () => void;
    private online = false;
    private faulted = false;
    constructor(private readonly services: SchedulerEngineDeps) {
        this.instant = services.now ?? (() => new Date());
        this.makeHistoryId = services.id ?? makeRunHistoryKey;
    }
    start(): void {
        this.stop();
        this.faulted = false;
        try {
            this.services.store.assertHistoryReady?.();
            this.advanceOldAppointments();
            this.online = true;
            this.detachStore = this.services.store.onChange(() => this.rearmWakeup());
            this.rearmWakeup();
        }
        catch (failure) {
            this.suspendAfterFailure(failure);
            throw failure;
        }
    }
    stop(): void {
        this.online = false;
        this.cancelWakeup();
        this.detachStore?.();
        this.detachStore = undefined;
    }
    refreshPluginTasks(): void {
        if (!this.online || this.faulted)
            return;
        try {
            this.advanceOldAppointments();
            this.rearmWakeup();
        }
        catch (failure) {
            this.suspendAfterFailure(failure);
        }
    }
    async fireNow(jobId: string): Promise<{
        ok: boolean;
        reason?: string;
    }> {
        this.services.store.assertHistoryReady?.();
        const job = this.services.store.getTasks().find((candidate) => candidate.id === jobId);
        if (!job)
            return { ok: false, reason: "task not found" };
        if (!isTaskEnabled(job))
            return { ok: false, reason: "task is disabled" };
        if (!this.hostAllows(job))
            return { ok: false, reason: "plugin not running" };
        if (this.activeJobs.has(job.id))
            return { ok: false, reason: "task already running" };
        const outcome = await this.executeExclusively(job, this.instant(), true);
        if (outcome?.ok)
            return { ok: true };
        return { ok: false, reason: outcome?.error ?? "task already running" };
    }
    private cancelWakeup(): void {
        if (this.wakeTimer)
            clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
    }
    private logSchedulingFailure(failure: unknown): void {
        try {
            console.error("[SchedulerEngine] scheduled operation failed:", failure);
        }
        catch {
        }
    }
    private suspendAfterFailure(failure: unknown): void {
        this.faulted = true;
        this.cancelWakeup();
        this.logSchedulingFailure(failure);
    }
    private appendSkip(job: ScheduledTask, scheduledInstant: Date, explanation: string): void {
        try {
            this.services.store.recordHistory({
                id: this.makeHistoryId(),
                taskId: job.id,
                taskTitle: job.title,
                firedAt: scheduledInstant.toISOString(),
                status: "skipped",
                reason: explanation,
                effectiveToolIds: [],
            });
        }
        catch (failure) {
            this.logSchedulingFailure(failure);
        }
    }
    private hostAllows(job: ScheduledTask): boolean {
        return this.services.canRunTask ? this.services.canRunTask(job) : true;
    }
    private stoppedJobPatch(job: ScheduledTask): Partial<ScheduledTask> {
        if (job.ownerPluginId)
            return { pluginUserEnabled: false, nextFireAt: null };
        return { enabled: false, nextFireAt: null };
    }
    private advanceOldAppointments(): void {
        const { store: repository } = this.services;
        repository.assertHistoryReady?.();
        const instant = this.instant();
        for (const job of repository.getTasks()) {
            repository.assertHistoryReady?.();
            if (!isTaskEnabled(job) || !job.nextFireAt)
                continue;
            const appointment = new Date(job.nextFireAt);
            if (Number.isNaN(appointment.getTime())) {
                repository.updateTask(job.id, this.stoppedJobPatch(job));
                continue;
            }
            if (appointment.getTime() > instant.getTime())
                continue;
            if (job.schedule.kind === "once") {
                repository.updateTask(job.id, this.stoppedJobPatch(job));
                this.appendSkip(job, instant, "missed while app was closed");
                continue;
            }
            const rescheduled = normalizeOverdueNextFireAt(job.schedule, appointment, instant);
            repository.updateTask(job.id, { nextFireAt: rescheduled ? rescheduled.toISOString() : null });
        }
    }
    private rearmWakeup(): void {
        this.cancelWakeup();
        if (!this.online || this.faulted)
            return;
        try {
            this.armEarliestAppointment();
        }
        catch (failure) {
            this.suspendAfterFailure(failure);
        }
    }
    private armEarliestAppointment(): void {
        this.services.store.assertHistoryReady?.();
        const instant = this.instant();
        const waitingJobs = this.services.store.getTasks().filter((candidate) => {
            if (!isTaskEnabled(candidate) || !candidate.nextFireAt)
                return false;
            return !Number.isNaN(new Date(candidate.nextFireAt).getTime());
        });
        waitingJobs.sort((left, right) => String(left.nextFireAt).localeCompare(String(right.nextFireAt)));
        const earliest = waitingJobs[0];
        if (!earliest?.nextFireAt)
            return;
        const delay = Math.max(0, new Date(earliest.nextFireAt).getTime() - instant.getTime());
        this.wakeTimer = setTimeout(() => {
            void this.dispatchReadyJobs().catch((failure) => this.suspendAfterFailure(failure));
        }, Math.min(delay, MAX_WAKE_INTERVAL));
    }
    private async dispatchReadyJobs(): Promise<void> {
        if (!this.online || this.faulted)
            return;
        try {
            const { store: repository } = this.services;
            repository.assertHistoryReady?.();
            const instant = this.instant();
            const readyJobs = repository.getTasks().filter((job) => {
                if (!isTaskEnabled(job) || !job.nextFireAt)
                    return false;
                return new Date(job.nextFireAt).getTime() <= instant.getTime();
            });
            for (const job of readyJobs) {
                if (!this.online || this.faulted)
                    break;
                repository.assertHistoryReady?.();
                const appointment = job.nextFireAt ? new Date(job.nextFireAt) : instant;
                const permitted = this.hostAllows(job);
                const successor = computeNextFireAtAfter(job.schedule, appointment);
                const upcoming = successor && successor.getTime() <= instant.getTime()
                    ? normalizeOverdueNextFireAt(job.schedule, successor, instant)
                    : successor;
                if (job.schedule.kind === "once") {
                    repository.updateTask(job.id, {
                        ...this.stoppedJobPatch(job),
                        lastFiredAt: appointment.toISOString(),
                    });
                }
                else {
                    repository.updateTask(job.id, {
                        nextFireAt: upcoming ? upcoming.toISOString() : null,
                        ...(permitted ? { lastFiredAt: appointment.toISOString() } : {}),
                    });
                }
                if (!this.online || this.faulted)
                    break;
                if (!permitted || !this.hostAllows(job)) {
                    this.appendSkip(job, appointment, "plugin not running");
                }
                else {
                    void this.executeExclusively(job, appointment, false).catch((failure) => this.logSchedulingFailure(failure));
                }
            }
        }
        catch (failure) {
            this.suspendAfterFailure(failure);
        }
        finally {
            this.rearmWakeup();
        }
    }
    private async executeExclusively(job: ScheduledTask, appointment: Date, requestedByUser: boolean): Promise<ScheduledRunResult | undefined> {
        if (this.activeJobs.has(job.id)) {
            if (!requestedByUser)
                this.appendSkip(job, appointment, "previous run still active");
            return undefined;
        }
        this.activeJobs.add(job.id);
        try {
            return await this.services.runTask(job, appointment, requestedByUser);
        }
        finally {
            this.activeJobs.delete(job.id);
        }
    }
}
