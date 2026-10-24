import { describe, expect, it, vi } from "vitest";
import { createLive2dWorkApi, type Live2dWorkIpcRenderer } from "../preload/live2d-work-api";
import { IPC } from "../shared/ipc-channels";

function fakeIpcRenderer(snapshot: unknown = false) {
  const listeners = new Map<string, Set<(event: unknown, working: unknown) => void>>();
  const ipc: Live2dWorkIpcRenderer = {
    on: vi.fn((channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel, listener) => {
      listeners.get(channel)?.delete(listener);
    }),
    invoke: vi.fn(async () => snapshot),
  };
  const emit = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, payload);
  };
  return { ipc, listeners, emit };
}

describe("Live2D work preload API", () => {
  it("reads the current working state as an initial snapshot", async () => {
    const working = fakeIpcRenderer(true);
    expect(await createLive2dWorkApi(working.ipc).getWorking()).toBe(true);
    expect(working.ipc.invoke).toHaveBeenCalledWith(IPC.LIVE2D_GET_WORKING);
    expect(await createLive2dWorkApi(fakeIpcRenderer(false).ipc).getWorking()).toBe(false);
    // 非 boolean 的返回不当作“在工作”
    expect(await createLive2dWorkApi(fakeIpcRenderer("yes").ipc).getWorking()).toBe(false);
  });

  it("treats a failed snapshot read as not working", async () => {
    const { ipc } = fakeIpcRenderer();
    ipc.invoke = vi.fn(async () => { throw new Error("no handler"); });
    expect(await createLive2dWorkApi(ipc).getWorking()).toBe(false);
  });

  it("subscribes to the working-changed channel and forwards boolean state", () => {
    const { ipc, emit } = fakeIpcRenderer();
    const api = createLive2dWorkApi(ipc);
    const callback = vi.fn();
    api.onChanged(callback);
    expect(ipc.on).toHaveBeenCalledWith(IPC.LIVE2D_WORKING_CHANGED, expect.any(Function));
    emit(IPC.LIVE2D_WORKING_CHANGED, true);
    emit(IPC.LIVE2D_WORKING_CHANGED, false);
    expect(callback.mock.calls).toEqual([[true], [false]]);
  });

  it("coerces non-boolean payloads to false instead of claiming work", () => {
    const { ipc, emit } = fakeIpcRenderer();
    const callback = vi.fn();
    createLive2dWorkApi(ipc).onChanged(callback);
    emit(IPC.LIVE2D_WORKING_CHANGED, "yes");
    emit(IPC.LIVE2D_WORKING_CHANGED, undefined);
    expect(callback.mock.calls).toEqual([[false], [false]]);
  });

  it("removes the same listener when unsubscribed and stops delivering state", () => {
    const { ipc, listeners, emit } = fakeIpcRenderer();
    const callback = vi.fn();
    const off = createLive2dWorkApi(ipc).onChanged(callback);
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith(IPC.LIVE2D_WORKING_CHANGED, vi.mocked(ipc.on).mock.calls[0][1]);
    expect(listeners.get(IPC.LIVE2D_WORKING_CHANGED)?.size ?? 0).toBe(0);
    emit(IPC.LIVE2D_WORKING_CHANGED, true);
    expect(callback).not.toHaveBeenCalled();
  });
});
