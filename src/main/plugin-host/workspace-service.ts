import type { PluginWorkspaceBinding, PluginWorkspaceService } from "../../plugins/api";
import { pluginHostError } from "./errors";

/** 宿主存储里工作区绑定的只读形状。 */
export interface PluginWorkspaceStoreReader {
  getWorkspaceBinding(sessionId: string): { workspaceRoot: string; displayName: string } | undefined;
}

export interface PluginWorkspaceServiceOptions {
  reader: PluginWorkspaceStoreReader;
  /** 插件停止信号；触发后每次调用都以 E_PLUGIN_STOPPING 失败。 */
  signal?: AbortSignal;
}

/**
 * 工作区只读视图：绑定缺失（含会话不存在）统一返回 null；
 * 不暴露任何写入、解绑或选目录的能力。
 */
export function createPluginWorkspaceService(options: PluginWorkspaceServiceOptions): PluginWorkspaceService {
  const reader = options.reader;
  const abortSignal = options.signal;

  return {
    async getBinding(conversationId) {
      if (abortSignal?.aborted) {
        throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，工作区服务不可用");
      }
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法会话 id: ${String(conversationId)}`);
      }
      const stored = reader.getWorkspaceBinding(conversationId);
      if (!stored) {
        return null;
      }
      // 仅投影对外稳定的三个字段，绑定的内部元数据不外露。
      const view: PluginWorkspaceBinding = {
        conversationId,
        root: stored.workspaceRoot,
        displayName: stored.displayName,
      };
      return view;
    },
  };
}
