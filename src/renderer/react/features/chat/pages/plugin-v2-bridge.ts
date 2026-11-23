import type {
  PluginManagementApi,
  PluginV2BorrowingEntry,
  PluginV2ConfirmPermission,
  PluginV2ConfirmRequest,
} from "../../../../../shared/plugin-management";
import type { ConfirmOptions } from "../../../../shared/feedback-types";

const CONFIRM_KEY_BY_PERMISSION: Record<PluginV2ConfirmPermission, string> = {
  "sessions.read": "workspaceNotices.pluginConfirmSessionsRead",
  "workspace.read": "workspaceNotices.pluginConfirmWorkspaceRead",
  "model.run": "workspaceNotices.pluginConfirmModelRun",
};

export interface PluginV2BridgeOptions {
  api: Pick<
    PluginManagementApi,
    | "getV2Borrowing"
    | "onV2BorrowingChanged"
    | "onV2ConfirmRequest"
    | "onV2ConfirmSettled"
    | "resolveV2Confirm"
  >;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  onBorrowingChange: (entries: PluginV2BorrowingEntry[]) => void;
  translate: (key: string, params?: Record<string, unknown>) => string;
}

export function attachPluginV2Listeners(options: PluginV2BridgeOptions): () => void {
  let disposed = false;
  const settledIds = new Set<string>();

  void options.api.getV2Borrowing?.()
    .then((result) => {
      if (!disposed && Array.isArray(result?.entries)) {
        options.onBorrowingChange(result.entries);
      }
    })
    .catch(() => {});

  const offBorrowing = options.api.onV2BorrowingChanged?.((payload) => {
    if (!disposed && Array.isArray(payload?.entries)) {
      options.onBorrowingChange(payload.entries);
    }
  });

  const offSettled = options.api.onV2ConfirmSettled?.((settled) => {
    if (settled?.id) settledIds.add(settled.id);
  });

  const offConfirm = options.api.onV2ConfirmRequest?.((request: PluginV2ConfirmRequest) => {
    if (disposed || !request?.id || settledIds.has(request.id)) return;
    const messageKey = CONFIRM_KEY_BY_PERMISSION[request.permission];
    const message = options.translate(messageKey, { name: request.pluginName });
    void options.confirm({
      title: options.translate("workspaceNotices.pluginConfirmTitle"),
      message,
      confirmText: options.translate("workspaceNotices.pluginConfirmAllow"),
      cancelText: options.translate("workspaceNotices.pluginConfirmDeny"),
      tone: "warning",
    })
      .then((allowed) => {
        if (disposed || settledIds.has(request.id)) return;
        settledIds.add(request.id);
        return options.api.resolveV2Confirm?.(request.id, allowed);
      })
      .catch(() => {
        if (!disposed && !settledIds.has(request.id)) {
          settledIds.add(request.id);
          void options.api.resolveV2Confirm?.(request.id, false);
        }
      });
  });

  return () => {
    disposed = true;
    offBorrowing?.();
    offSettled?.();
    offConfirm?.();
  };
}
