import { describe, expect, test, vi } from "vitest";
import { t } from "../../../i18n";
import { attachPluginV2Listeners } from "./plugin-v2-bridge";
import type {
  PluginV2BorrowingEntry,
  PluginV2ConfirmRequest,
  PluginV2ConfirmSettled,
} from "../../../../../shared/plugin-management";

function createBridgeHarness() {
  let borrowingCb: ((payload: { entries: PluginV2BorrowingEntry[] }) => void) | undefined;
  let confirmCb: ((request: PluginV2ConfirmRequest) => void) | undefined;
  let settledCb: ((settled: PluginV2ConfirmSettled) => void) | undefined;
  const api = {
    getV2Borrowing: vi.fn(async () => ({ entries: [] as PluginV2BorrowingEntry[] })),
    onV2BorrowingChanged: vi.fn((cb: typeof borrowingCb) => {
      borrowingCb = cb;
      return () => { borrowingCb = undefined; };
    }),
    onV2ConfirmRequest: vi.fn((cb: typeof confirmCb) => {
      confirmCb = cb;
      return () => { confirmCb = undefined; };
    }),
    onV2ConfirmSettled: vi.fn((cb: typeof settledCb) => {
      settledCb = cb;
      return () => { settledCb = undefined; };
    }),
    resolveV2Confirm: vi.fn(async () => ({ ok: true })),
  };
  return {
    api,
    emitBorrowing: (entries: PluginV2BorrowingEntry[]) => borrowingCb?.({ entries }),
    emitConfirm: (req: PluginV2ConfirmRequest) => confirmCb?.(req),
    emitSettled: (settled: PluginV2ConfirmSettled) => settledCb?.(settled),
  };
}

describe("attachPluginV2Listeners", () => {
  test("displays the exact Chinese confirmation prompt for each permission and resolves user decision", async () => {
    const harness = createBridgeHarness();
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onBorrowingChange = vi.fn();

    const dispose = attachPluginV2Listeners({
      api: harness.api,
      confirm,
      onBorrowingChange,
      translate: t,
    });

    harness.emitConfirm({ id: "c-1", pluginId: "p1", pluginName: "记忆助手", permission: "sessions.read" });
    harness.emitConfirm({ id: "c-2", pluginId: "p1", pluginName: "记忆助手", permission: "workspace.read" });
    harness.emitConfirm({ id: "c-3", pluginId: "p1", pluginName: "记忆助手", permission: "model.run" });

    await vi.waitFor(() => expect(harness.api.resolveV2Confirm).toHaveBeenCalledTimes(3));

    expect(confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: "插件〔记忆助手〕想要读取会话记录，是否允许？",
    }));
    expect(confirm).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "插件〔记忆助手〕想要读取工作区信息，是否允许？",
    }));
    expect(confirm).toHaveBeenNthCalledWith(3, expect.objectContaining({
      message: "插件〔记忆助手〕想要发起完整模型运行，是否允许？",
    }));

    expect(harness.api.resolveV2Confirm).toHaveBeenNthCalledWith(1, "c-1", true);
    expect(harness.api.resolveV2Confirm).toHaveBeenNthCalledWith(2, "c-2", false);
    expect(harness.api.resolveV2Confirm).toHaveBeenNthCalledWith(3, "c-3", true);

    dispose();
  });

  test("ignores confirmation settlement if host already cancelled the request", async () => {
    const harness = createBridgeHarness();
    let resolveDialog!: (allowed: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { resolveDialog = resolve; }));

    const dispose = attachPluginV2Listeners({
      api: harness.api,
      confirm,
      onBorrowingChange: vi.fn(),
      translate: t,
    });

    harness.emitConfirm({ id: "c-cancel", pluginId: "p1", pluginName: "Demo", permission: "model.run" });
    harness.emitSettled({ id: "c-cancel", reason: "cancelled" });
    resolveDialog(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.api.resolveV2Confirm).not.toHaveBeenCalled();
    dispose();
  });

  test("syncs initial and live model borrowing entries", async () => {
    const harness = createBridgeHarness();
    harness.api.getV2Borrowing.mockResolvedValueOnce({
      entries: [{ id: "b-0", pluginId: "p1", pluginName: "初始插件" }],
    });
    const onBorrowingChange = vi.fn();

    const dispose = attachPluginV2Listeners({
      api: harness.api,
      confirm: vi.fn(async () => false),
      onBorrowingChange,
      translate: t,
    });

    await vi.waitFor(() => {
      expect(onBorrowingChange).toHaveBeenCalledWith([{ id: "b-0", pluginId: "p1", pluginName: "初始插件" }]);
    });

    harness.emitBorrowing([]);
    expect(onBorrowingChange).toHaveBeenLastCalledWith([]);
    dispose();
  });
});
