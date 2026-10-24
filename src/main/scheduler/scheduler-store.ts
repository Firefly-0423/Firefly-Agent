import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { app } from "electron";
import type { PluginPromptMode } from "../../plugins/api";
import { AtomicJsonStore } from "../storage/atomic-json-store";
import { computeInitialNextFireAt, normalizeOverdueNextFireAt } from "./schedule-calculator";
import type { NewScheduledTaskInput, ScheduledTask, ScheduledTaskHistoryEntry, ScheduledTaskPatch, ScheduleConfig, SchedulerToolMode, } from "./types";
interface StoreDeps {
    tasksFile: string;
    historyFile: string;
    now: () => Date;
    id: () => string;
}
const PROCESS_INSTANCE = `${process.pid}:${performance.timeOrigin}`;
const MAX_HISTORY_PER_JOB = 50;
const MAX_HISTORY_TOTAL = 1000;
function systemPorts(): StoreDeps {
    return {
        tasksFile: path.join(app.getPath("userData"), "scheduled-tasks.json"),
        historyFile: path.join(app.getPath("userData"), "scheduled-tasks-history.jsonl"),
        now: () => new Date(),
        id: () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
}
function prepareDirectory(filename: string): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
}
function cleanToolIds(toolIds: string[]): string[] {
    const trimmedIds = toolIds.map((v) => String(v).trim()).filter(Boolean);
    return Array.from(new Set(trimmedIds));
}
function assertClockText(clockText: string, fieldLabel: string): void {
    const digits = /^(\d{2}):(\d{2})$/.exec(clockText);
    if (!digits)
        throw new Error(`${fieldLabel}格式必须是 HH:mm`);
    const hour = Number(digits[1]);
    const minute = Number(digits[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
        throw new Error(`${fieldLabel}必须是有效时间`);
}
export function validateSchedule(plan: ScheduleConfig): void {
    if (!plan || typeof plan !== "object")
        throw new Error("缺少调度配置");
    switch (plan.kind) {
        case "daily":
            assertClockText(plan.timeOfDay, "每日时间");
            return;
        case "weekly": {
            const weekday = plan.dayOfWeek;
            if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
                throw new Error("星期必须是 0-6");
            assertClockText(plan.timeOfDay, "每周时间");
            return;
        }
        case "interval": {
            const { every: count, unit: period } = plan;
            if (!Number.isInteger(count) || count <= 0)
                throw new Error("间隔必须是正整数");
            if (period === "minutes" && count > 1440)
                throw new Error("分钟间隔不能超过 1440");
            if (period === "hours" && count > 168)
                throw new Error("小时间隔不能超过 168");
            if (period !== "minutes" && period !== "hours")
                throw new Error("间隔单位无效");
            return;
        }
        case "once":
            if (Number.isNaN(new Date(plan.runAt).getTime()))
                throw new Error("一次性运行时间无效");
            return;
        default:
            throw new Error("未知调度类型");
    }
}
function readToolScope(candidate: unknown): SchedulerToolMode {
    return candidate === "allow-list" ? "allow-list" : "all-enabled";
}
function readConversationMode(candidate: unknown): PluginPromptMode | undefined {
    if (candidate === "chat" || candidate === "work" || candidate === "code")
        return candidate;
    return undefined;
}
function decodeJob(candidate: unknown): ScheduledTask | null {
    if (!candidate || typeof candidate !== "object")
        return null;
    const job = candidate as Partial<ScheduledTask>;
    if (typeof job.id !== "string" || !job.id.trim())
        return null;
    if (typeof job.title !== "string" || typeof job.prompt !== "string")
        return null;
    if (!job.schedule)
        return null;
    try {
        validateSchedule(job.schedule);
    }
    catch {
        return null;
    }
    const pluginOwner = typeof job.ownerPluginId === "string" && job.ownerPluginId.trim() ? job.ownerPluginId : undefined;
    return {
        id: job.id,
        title: job.title.trim(),
        prompt: job.prompt.trim(),
        enabled: pluginOwner ? false : job.enabled !== false,
        schedule: job.schedule,
        nextFireAt: typeof job.nextFireAt === "string" ? job.nextFireAt : null,
        lastFiredAt: typeof job.lastFiredAt === "string" ? job.lastFiredAt : undefined,
        toolMode: pluginOwner ? "allow-list" : readToolScope(job.toolMode),
        allowedToolIds: cleanToolIds(Array.isArray(job.allowedToolIds) ? job.allowedToolIds : []),
        createdAt: typeof job.createdAt === "string" ? job.createdAt : new Date(0).toISOString(),
        updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : new Date(0).toISOString(),
        ...(pluginOwner ? {
            ownerPluginId: pluginOwner,
            pluginUserEnabled: job.pluginUserEnabled === true,
            mode: (job.mode as unknown) === "learn" ? "work" : readConversationMode(job.mode),
            approvalFingerprint: typeof job.approvalFingerprint === "string" ? job.approvalFingerprint : "",
        } : {}),
    };
}
export function createSchedulerStore(ports: StoreDeps) {
    let jobs: ScheduledTask[] = [];
    let taskReadFailure: Error | undefined;
    let recoveryFailure: Error | undefined;
    let observers: Array<(upcoming: ScheduledTask[]) => void> = [];
    const taskFile = new AtomicJsonStore<{
        tasks: unknown[];
    }>(ports.tasksFile, (candidate) => candidate !== null && typeof candidate === "object" && Array.isArray((candidate as {
        tasks?: unknown;
    }).tasks));
    function cloneJob(job: ScheduledTask): ScheduledTask {
        return { ...job, schedule: { ...job.schedule }, allowedToolIds: [...job.allowedToolIds] };
    }
    function requireTaskFile(): void {
        if (taskReadFailure)
            throw taskReadFailure;
    }
    function requireHistory(): void {
        if (recoveryFailure)
            throw recoveryFailure;
    }
    function publishJobs(): void {
        for (const observer of observers) {
            try {
                observer(jobs.map(cloneJob));
            }
            catch (failure) {
                console.warn("[SchedulerStore] listener failed:", failure);
            }
        }
    }
    function persistJobs(upcoming: ScheduledTask[]): void {
        requireTaskFile();
        const persisted = upcoming.map(cloneJob);
        taskFile.write({ tasks: persisted });
        jobs = persisted;
        publishJobs();
    }
    function readJournal(): ScheduledTaskHistoryEntry[] {
        try {
            const contents = fs.readFileSync(ports.historyFile, "utf8");
            return contents.split(/\r?\n/)
                .filter(Boolean)
                .map((recordLine) => JSON.parse(recordLine) as ScheduledTaskHistoryEntry)
                .filter((row) => row && typeof row.taskId === "string");
        }
        catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ENOENT")
                return [];
            throw new Error("SCHEDULER_HISTORY_UNAVAILABLE", { cause: failure });
        }
    }
    function replaceJournal(journal: ScheduledTaskHistoryEntry[]): void {
        const encoded = journal.map((row) => JSON.stringify(row)).join("\n") + (journal.length ? "\n" : "");
        const stagedFile = path.join(path.dirname(ports.historyFile), `.${path.basename(ports.historyFile)}.${randomUUID()}.tmp`);
        try {
            prepareDirectory(ports.historyFile);
            fs.writeFileSync(stagedFile, encoded, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
            fs.renameSync(stagedFile, ports.historyFile);
        }
        catch (failure) {
            try {
                fs.unlinkSync(stagedFile);
            }
            catch (removalFailure) {
                if ((removalFailure as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw new Error("SCHEDULER_HISTORY_WRITE_FAILED", {
                        cause: new AggregateError([failure, removalFailure]),
                    });
                }
            }
            throw new Error("SCHEDULER_HISTORY_WRITE_FAILED", { cause: failure });
        }
    }
    function reconcileJournal(): void {
        try {
            const journal = readJournal();
            let needsRewrite = false;
            const recovered = journal.map((row) => {
                if (row.status !== "running" || row.hostEpoch === PROCESS_INSTANCE)
                    return row;
                needsRewrite = true;
                return {
                    ...row,
                    status: "interrupted" as const,
                    executionOutcome: "unknown" as const,
                    externalEffectsMayContinue: true,
                    recoveredAt: ports.now().toISOString(),
                    reason: "host_interrupted",
                };
            });
            if (needsRewrite)
                replaceJournal(recovered);
            recoveryFailure = undefined;
        }
        catch (failure) {
            const alreadyKnown = failure instanceof Error && failure.message === "SCHEDULER_HISTORY_UNAVAILABLE";
            recoveryFailure = alreadyKnown
                ? failure : new Error("SCHEDULER_HISTORY_RECOVERY_FAILED", { cause: failure });
        }
    }
    function load(): void {
        try {
            const loaded = taskFile.read({ tasks: [] });
            jobs = loaded.tasks
                .map(decodeJob)
                .filter((job): job is ScheduledTask => job !== null)
                .map(cloneJob);
            taskReadFailure = undefined;
        }
        catch (failure) {
            taskReadFailure = new Error("SCHEDULER_TASKS_UNAVAILABLE", { cause: failure });
        }
        reconcileJournal();
    }
    function getTasks(): ScheduledTask[] {
        requireTaskFile();
        return jobs.map(cloneJob);
    }
    function allocateJobId(): string {
        const usedIds = new Set(jobs.map((job) => job.id));
        let candidate = ports.id();
        for (let attempt = 1; usedIds.has(candidate); attempt++) {
            candidate = `${ports.id()}-${attempt}`;
        }
        return candidate;
    }
    function addTask(request: NewScheduledTaskInput): ScheduledTask {
        requireTaskFile();
        const cleanTitle = String(request.title ?? "").trim();
        const cleanPrompt = String(request.prompt ?? "").trim();
        if (!cleanTitle)
            throw new Error("标题不能为空");
        if (!cleanPrompt)
            throw new Error("提示词不能为空");
        validateSchedule(request.schedule);
        if (request.mode !== undefined && readConversationMode(request.mode) === undefined) {
            throw new Error("会话模式无效");
        }
        const instant = ports.now();
        const upcoming = computeInitialNextFireAt(request.schedule, instant);
        if (request.schedule.kind === "once" && !upcoming)
            throw new Error("一次性任务时间必须晚于当前时间");
        const pluginOwner = typeof request.ownerPluginId === "string" && request.ownerPluginId.trim() ? request.ownerPluginId : undefined;
        const newJob: ScheduledTask = {
            id: allocateJobId(),
            title: cleanTitle,
            prompt: cleanPrompt,
            enabled: pluginOwner ? false : (request.enabled ?? true),
            schedule: request.schedule,
            nextFireAt: upcoming ? upcoming.toISOString() : null,
            toolMode: pluginOwner ? "allow-list" : readToolScope(request.toolMode),
            allowedToolIds: cleanToolIds(request.allowedToolIds ?? []),
            createdAt: instant.toISOString(),
            updatedAt: instant.toISOString(),
            ...(pluginOwner ? {
                ownerPluginId: pluginOwner,
                pluginUserEnabled: request.pluginUserEnabled === true,
                mode: readConversationMode(request.mode),
                approvalFingerprint: typeof request.approvalFingerprint === "string" ? request.approvalFingerprint : "",
            } : {}),
        };
        persistJobs([...jobs, newJob]);
        return cloneJob(newJob);
    }
    function updateTask(jobId: string, changes: ScheduledTaskPatch): ScheduledTask {
        requireTaskFile();
        const position = jobs.findIndex((candidate) => candidate.id === jobId);
        if (position < 0)
            throw new Error("任务不存在");
        const previous = jobs[position];
        const pluginManaged = previous.ownerPluginId !== undefined;
        const instant = ports.now();
        const plan = changes.schedule ?? previous.schedule;
        validateSchedule(plan);
        if (changes.mode !== undefined && readConversationMode(changes.mode) === undefined) {
            throw new Error("会话模式无效");
        }
        const cleanTitle = changes.title !== undefined ? String(changes.title).trim() : previous.title;
        const cleanPrompt = changes.prompt !== undefined ? String(changes.prompt).trim() : previous.prompt;
        if (!cleanTitle)
            throw new Error("标题不能为空");
        if (!cleanPrompt)
            throw new Error("提示词不能为空");
        const planChanged = changes.schedule !== undefined;
        const userEnabledNow = !pluginManaged && changes.enabled === true && previous.enabled === false;
        const pluginEnabledNow = pluginManaged && changes.pluginUserEnabled === true && previous.pluginUserEnabled !== true;
        let upcoming: Date | null;
        if (Object.prototype.hasOwnProperty.call(changes, "nextFireAt")) {
            upcoming = changes.nextFireAt ? new Date(changes.nextFireAt) : null;
        }
        else if (planChanged) {
            upcoming = computeInitialNextFireAt(plan, instant);
        }
        else {
            upcoming = previous.nextFireAt ? new Date(previous.nextFireAt) : null;
        }
        if (upcoming && Number.isNaN(upcoming.getTime()))
            upcoming = null;
        if (plan.kind === "once" && planChanged && !upcoming) {
            throw new Error("一次性任务时间必须晚于当前时间");
        }
        if (userEnabledNow || pluginEnabledNow) {
            if (!upcoming || Number.isNaN(upcoming.getTime())) {
                upcoming = computeInitialNextFireAt(plan, instant);
            }
            else if (upcoming.getTime() <= instant.getTime()) {
                upcoming = normalizeOverdueNextFireAt(plan, upcoming, instant);
            }
            if (plan.kind === "once" && (!upcoming || upcoming.getTime() <= instant.getTime()))
                upcoming = null;
        }
        const replacement: ScheduledTask = {
            ...previous,
            ...changes,
            title: cleanTitle,
            prompt: cleanPrompt,
            schedule: plan,
            nextFireAt: upcoming ? upcoming.toISOString() : null,
            enabled: pluginManaged ? false : (changes.enabled ?? previous.enabled),
            toolMode: pluginManaged ? "allow-list" : readToolScope(changes.toolMode ?? previous.toolMode),
            allowedToolIds: changes.allowedToolIds ? cleanToolIds(changes.allowedToolIds) : [...previous.allowedToolIds],
            updatedAt: instant.toISOString(),
        };
        persistJobs([...jobs.slice(0, position), replacement, ...jobs.slice(position + 1)]);
        return cloneJob(replacement);
    }
    function deleteTask(jobId: string): boolean {
        requireTaskFile();
        const survivors = jobs.filter((candidate) => candidate.id !== jobId);
        if (survivors.length === jobs.length)
            return false;
        persistJobs(survivors);
        return true;
    }
    function deleteTasksByOwner(ownerId: string): number {
        requireTaskFile();
        const originalCount = jobs.length;
        const survivors = jobs.filter((candidate) => candidate.ownerPluginId !== ownerId);
        if (survivors.length === originalCount)
            return 0;
        persistJobs(survivors);
        return originalCount - survivors.length;
    }
    function toggleTask(jobId: string, active: boolean): ScheduledTask {
        return updateTask(jobId, { enabled: active });
    }
    function recordHistory(row: ScheduledTaskHistoryEntry): void {
        requireHistory();
        const journal = readJournal().filter((historicalRow) => historicalRow.id !== row.id);
        journal.push(row.status === "running" ? { ...row, hostEpoch: PROCESS_INSTANCE } : row);
        const grouped = new Map<string, ScheduledTaskHistoryEntry[]>();
        for (const row of journal) {
            const perJob = grouped.get(row.taskId);
            if (perJob)
                perJob.push(row);
            else
                grouped.set(row.taskId, [row]);
        }
        const retained = Array.from(grouped.values()).flatMap((perJob) => perJob.sort((left, right) => left.firedAt.localeCompare(right.firedAt)).slice(-MAX_HISTORY_PER_JOB));
        retained.sort((left, right) => left.firedAt.localeCompare(right.firedAt));
        replaceJournal(retained.slice(-MAX_HISTORY_TOTAL));
    }
    function getHistory(taskId: string, maximum = 10): ScheduledTaskHistoryEntry[] {
        requireHistory();
        return readJournal()
            .filter((row) => row.taskId === taskId)
            .sort((left, right) => right.firedAt.localeCompare(left.firedAt))
            .slice(0, maximum);
    }
    function onChange(observer: (upcoming: ScheduledTask[]) => void): () => void {
        observers.push(observer);
        return () => {
            observers = observers.filter((candidate) => candidate !== observer);
        };
    }
    return {
        load,
        getTasks,
        addTask,
        updateTask,
        deleteTask,
        deleteTasksByOwner,
        toggleTask,
        recordHistory,
        getHistory,
        assertHistoryReady: requireHistory,
        onChange,
    };
}
let sharedRepository: ReturnType<typeof createSchedulerStore> | null = null;
export function getSchedulerStore(): ReturnType<typeof createSchedulerStore> {
    if (!sharedRepository)
        sharedRepository = createSchedulerStore(systemPorts());
    return sharedRepository;
}
