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
    getV2Confirms: vi.fn(async () => ({ requests: [] as PluginV2ConfirmRequest[] })),
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

  test("aborts the open or queued dialog when the host settles the request first", async () => {
    const harness = createBridgeHarness();
    const signals: AbortSignal[] = [];
    const confirm = vi.fn((options: { signal?: AbortSignal }) => {
      if (options.signal) signals.push(options.signal);
      return new Promise<boolean>(() => {});
    });

    const dispose = attachPluginV2Listeners({ api: harness.api, confirm, onBorrowingChange: vi.fn(), translate: t });

    harness.emitConfirm({ id: "c-open", pluginId: "p1", pluginName: "Demo", permission: "model.run" });
    harness.emitConfirm({ id: "c-other", pluginId: "p2", pluginName: "Other", permission: "sessions.read" });
    expect(signals).toHaveLength(2);

    harness.emitSettled({ id: "c-open", reason: "timeout" });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(harness.api.resolveV2Confirm).not.toHaveBeenCalled();

    dispose();
    expect(signals[1].aborted).toBe(true);
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

  test("fetches pending confirmations on attach and deduplicates against live and settled events", async () => {
    const harness = createBridgeHarness();
    const pendingReq: PluginV2ConfirmRequest = {
      id: "c-pending",
      pluginId: "p1",
      pluginName: "Demo",
      permission: "sessions.read",
    };
    const settledReq: PluginV2ConfirmRequest = {
      id: "c-settled",
      pluginId: "p1",
      pluginName: "Demo",
      permission: "workspace.read",
    };
    let resolvePendingList!: (value: { requests: PluginV2ConfirmRequest[] }) => void;
    harness.api.getV2Confirms.mockImplementationOnce(
      () => new Promise<{ requests: PluginV2ConfirmRequest[] }>((resolve) => { resolvePendingList = resolve; }),
    );
    const confirm = vi.fn().mockResolvedValue(true);

    const dispose = attachPluginV2Listeners({
      api: harness.api,
      confirm,
      onBorrowingChange: vi.fn(),
      translate: t,
    });

    // Live push for c-pending and settlement for c-settled arrive before getV2Confirms resolves.
    harness.emitConfirm(pendingReq);
    harness.emitSettled({ id: "c-settled", reason: "cancelled" });
    resolvePendingList({ requests: [pendingReq, settledReq] });

    await vi.waitFor(() => expect(harness.api.resolveV2Confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(harness.api.resolveV2Confirm).toHaveBeenCalledWith("c-pending", true);
    dispose();
  });
});
