import type { IpcScope } from "../application/ipc-scope";
import { logger, LogTag } from "../logger";
import * as gate from "../permission";
import { registerChoiceIpc } from "../user-choice";

/**
 * 权限子系统的启动入口，须在窗口创建之后、首个工具调用之前执行。
 * 顺序固定：先读回已保存的档位，再把权限与选择卡片的 IPC 挂到同一个 scope 上
 * （由组合根统一注销），最后记一条日志。
 */
export function bootstrapPermission(ipc?: IpcScope): void {
  gate.initPermissionFromDisk();
  gate.registerPermissionIpc(ipc);
  registerChoiceIpc(ipc);
  logger.info(LogTag.Firefly, "当前 agent 权限档位:", gate.getCurrentLevel());
}
