import { randomUUID } from "node:crypto";
import { app, dialog, safeStorage, type WebContents } from "electron";
import type { IpcScope } from "../base/ipc/ipc-scope";
import { getStorageContext } from "../base/storage/storage-context";
import { loadModelSettings } from "../model/config/model-settings";
import { loadGeneralSettings } from "../platform/settings/settings-facade";
import { activeChatTargetRegistry } from "../platform/interaction/active-chat-target";
import { toolRegistry } from "../tooling/registry/tool-registry";
import type { LlmClient } from "../agent/services/llm/llm-client";
import type { BuildOptionsFn } from "../agent/runtime/run-input-types";
import * as chatsStore from "../features/sessions/chats-store";
import type { PluginSchedulerStorePort } from "../../plugins/v2/schedules";
import type { ServicePermission } from "../../plugins/v2/services";
import {
  createPluginV2HostController,
  type PluginV2BorrowingEntry,
  type PluginV2ConfirmRequest,
  type PluginV2HostController,
} from "../features/plugins/host/plugin-v2-services";
import { registerPluginProposalIpc } from "../features/scheduler/plugin-proposal-ipc";
import { IPC } from "../../shared/ipc-channels";

export interface PluginV2BootstrapDeps {
  ipc: IpcScope;
  llmClient: Pick<LlmClient, "chatNonStream">;
  buildRunOptions: BuildOptionsFn;
  schedulerStore: PluginSchedulerStorePort;
  getChatWebContents: () => WebContents | null;
  confirmTimeoutMs?: number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
/** Custom scheduler event telling the panel that plugin schedule proposals or tasks changed. */
const PLUGIN_PROPOSALS_CHANGED_EVENT = "scheduler.plugin_proposals_changed";

const CONFIRM_TEXT: Record<"sessions.read" | "workspace.read" | "model.run", (name: string) => string> = {
  "sessions.read": (name) => `插件〔${name}〕想要读取会话记录，是否允许？`,
  "workspace.read": (name) => `插件〔${name}〕想要读取工作区信息，是否允许？`,
  "model.run": (name) => `插件〔${name}〕想要发起完整模型运行，是否允许？`,
};

function isConfirmationPermission(permission: ServicePermission): permission is "sessions.read" | "workspace.read" | "model.run" {
  return permission === "sessions.read" || permission === "workspace.read" || permission === "model.run";
}

export async function startPluginV2Bootstrap(deps: PluginV2BootstrapDeps): Promise<PluginV2HostController> {
  const storage = getStorageContext();
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const pendingConfirms = new Map<string, { request: PluginV2ConfirmRequest; resolve: (allowed: boolean) => void }>();

  const sendToChat = (channel: string, payload: unknown): boolean => {
    const target = deps.getChatWebContents();
    if (!target || target.isDestroyed()) return false;
    try {
      target.send(channel, payload);
      return true;
    } catch {
      return false;
    }
  };

  deps.ipc.handle(IPC.PLUGINS_V2_CONFIRM_GET, () => ({
    requests: [...pendingConfirms.values()].map((entry) => entry.request),
  }));

  deps.ipc.handle(IPC.PLUGINS_V2_CONFIRM_RESOLVE, (_event, payload: unknown) => {
    const record = payload as { id?: unknown; allowed?: unknown } | null;
    if (!record || typeof record.id !== "string") return { ok: false };
    const waiter = pendingConfirms.get(record.id);
    if (!waiter) return { ok: false };
    pendingConfirms.delete(record.id);
    waiter.resolve(Boolean(record.allowed));
    sendToChat(IPC.PLUGINS_V2_CONFIRM_SETTLED, { id: record.id, reason: "answered" });
    return { ok: true };
  });

  const confirmFirstUse = async (request: {
    pluginId: string;
    pluginName: string;
    permission: ServicePermission;
    signal: AbortSignal;
  }): Promise<boolean> => {
    if (!isConfirmationPermission(request.permission)) return true;
    if (request.signal.aborted) return false;

    const id = randomUUID();
    const payload: PluginV2ConfirmRequest = {
      id,
      pluginId: request.pluginId,
      pluginName: request.pluginName,
      permission: request.permission,
    };

    const delivered = sendToChat(IPC.PLUGINS_V2_CONFIRM_REQUEST, payload);
    if (delivered) {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (allowed: boolean, reason: "answered" | "cancelled") => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          request.signal.removeEventListener("abort", onAbort);
          pendingConfirms.delete(id);
          if (reason === "cancelled") {
            sendToChat(IPC.PLUGINS_V2_CONFIRM_SETTLED, { id, reason: "cancelled" });
          }
          resolve(allowed);
        };
        const onAbort = () => finish(false, "cancelled");
        pendingConfirms.set(id, {
          request: payload,
          resolve: (allowed) => finish(allowed, "answered"),
        });
        timer = setTimeout(() => finish(false, "cancelled"), confirmTimeoutMs);
        request.signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    // Fallback when no chat window is open yet.
    try {
      const response = await dialog.showMessageBox({
        type: "question",
        title: "插件权限确认",
        message: CONFIRM_TEXT[request.permission](request.pluginName),
        buttons: ["拒绝", "允许"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return !request.signal.aborted && response.response === 1;
    } catch {
      return false;
    }
  };

  let controller!: PluginV2HostController;

  controller = createPluginV2HostController({
    dataRoot: storage.dataRoot,
    stateFile: storage.files.pluginState,
    toolRegistry,
    safeStorage,
    schedulerStore: deps.schedulerStore,
    llmClient: deps.llmClient,
    buildRunOptions: deps.buildRunOptions,
    loadModelSettings,
    loadGeneralSettings: () => loadGeneralSettings() as unknown as Record<string, unknown>,
    protectedRoots: [storage.profile.appData, storage.profile.userData, storage.profile.sessionData, storage.profile.logs, app.getAppPath()],
    listSessions: chatsStore.listSessions,
    getSession: chatsStore.getSession,
    getActiveChatTarget: () => {
      const active = activeChatTargetRegistry.getActive();
      return active ? { sessionId: active.sessionId, mode: active.mode } : null;
    },
    onActiveTargetInvalidated: (listener) => {
      const offInvalidated = activeChatTargetRegistry.onInvalidated(() => listener());
      const offDeleted = activeChatTargetRegistry.onSessionDeleted(() => listener());
      return () => {
        offInvalidated();
        offDeleted();
      };
    },
    onWorkspaceBindingChanged: (listener) => chatsStore.onWorkspaceBindingChanged?.(listener) ?? (() => {}),
    confirmFirstUse,
    onBorrowingChanged: (entries: PluginV2BorrowingEntry[]) => {
      sendToChat(IPC.PLUGINS_V2_BORROWING_CHANGED, { entries });
    },
    onScheduleStateChanged: () => {
      // Same channel the scheduler panel already listens on; it reloads the proposal list and the task list.
      sendToChat(IPC.SCHEDULER_EVENT, { type: "CUSTOM", name: PLUGIN_PROPOSALS_CHANGED_EVENT });
    },
    onToolProgress: (progress) => {
      sendToChat(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "firefly.tool_progress",
        ...(progress.runId ? { runId: progress.runId } : {}),
        ...(progress.sessionId ? { threadId: progress.sessionId } : {}),
        value: {
          toolCallId: progress.callId,
          message: progress.message,
          ...(progress.percent !== undefined ? { percent: progress.percent } : {}),
        },
      });
    },
  });

  registerPluginProposalIpc(
    deps.ipc,
    controller.scheduleService,
    (pluginId) => controller.stateStore.get(pluginId)?.manifest.name,
  );

  deps.ipc.handle(IPC.PLUGINS_V2_BORROWING_GET, () => ({
    entries: controller.getBorrowingEntries(),
  }));

  deps.ipc.handle(IPC.PLUGINS_V2_BORROWING_STOP, (_event, payload: unknown) => {
    const filter = (payload && typeof payload === "object" ? payload : undefined) as { id?: unknown; pluginId?: unknown } | undefined;
    const target = {
      ...(typeof filter?.id === "string" && filter.id ? { id: filter.id } : {}),
      ...(typeof filter?.pluginId === "string" && filter.pluginId ? { pluginId: filter.pluginId } : {}),
    };
    const stopped = controller.stopBorrowing(Object.keys(target).length ? target : undefined);
    return { ok: true, stopped };
  });

  await controller.startEnabled();
  return controller;
}

export function forwardHostEventToPluginV2(
  controller: PluginV2HostController,
  event: string,
  payload: unknown,
): void {
  if (!payload || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  const now = Date.now();
  switch (event) {
    case "turn:started": {
      const mode = record.mode as "chat" | "work" | "code" | undefined;
      const runId = typeof record.runId === "string" ? record.runId : "";
      if (!mode || !runId) return;
      const source = record.source === "desktop" ? "user" : record.source === "scheduler" ? "schedule" : "channel";
      const sessionId = typeof record.conversationId === "string"
        ? record.conversationId
        : (typeof record.taskId === "string" ? record.taskId : "");
      controller.publishHostEvent({ type: "run.started", runId, sessionId, mode, source, at: now });
      return;
    }
    case "turn:finished": {
      const runId = typeof record.runId === "string" ? record.runId : "";
      if (!runId) return;
      const status = record.status;
      const outcome = status === "success" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
      const sessionId = typeof record.conversationId === "string"
        ? record.conversationId
        : (typeof record.taskId === "string" ? record.taskId : "");
      controller.publishHostEvent({ type: "run.ended", runId, sessionId, outcome, at: now });
      return;
    }
    case "tool:finished": {
      const runId = typeof record.runId === "string" ? record.runId : "";
      const tool = typeof record.toolId === "string" ? record.toolId : "";
      if (!runId || !tool) return;
      const rawStatus = record.status;
      const status = rawStatus === "success"
        ? "succeeded"
        : rawStatus === "failure"
          ? "failed"
          : rawStatus === "unknown"
            ? "unknown"
            : "not_executed";
      const durationMs = typeof record.durationMs === "number" ? record.durationMs : 0;
      controller.publishHostEvent({ type: "tool.completed", runId, tool, status, durationMs, at: now });
      return;
    }
    case "scheduler:finished": {
      const taskId = typeof record.taskId === "string" ? record.taskId : "";
      if (!taskId) return;
      const status = record.status;
      const outcome = status === "success" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
      controller.publishHostEvent({ type: "schedule.completed", taskId, outcome, at: now });
      return;
    }
  }
}
