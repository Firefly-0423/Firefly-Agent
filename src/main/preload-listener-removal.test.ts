import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc-channels";

type Listener = (event: unknown, ...args: unknown[]) => void;

const fixture = vi.hoisted(() => {
  const exposed = new Map<string, Record<string, any>>();
  const listeners = new Map<string, Set<Listener>>();
  const invoke = vi.fn();
  const send = vi.fn();

  const on = vi.fn((channel: string, listener: Listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(channel, set);
  });

  const removeFromChannel = (channel: string, listener: Listener) => {
    listeners.get(channel)?.delete(listener);
  };

  const off = vi.fn(removeFromChannel);
  const removeListener = vi.fn(removeFromChannel);

  return { exposed, listeners, invoke, send, on, off, removeListener };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: Record<string, any>) => {
      fixture.exposed.set(name, value);
    },
  },
  ipcRenderer: {
    invoke: fixture.invoke,
    send: fixture.send,
    on: fixture.on,
    off: fixture.off,
    removeListener: fixture.removeListener,
  },
  webFrame: {},
  webUtils: {},
}));

function emit(channel: string, ...args: unknown[]): void {
  for (const listener of [...(fixture.listeners.get(channel) ?? [])]) {
    listener({}, ...args);
  }
}

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

interface SubscriptionCase {
  apiName: string;
  methodName: string;
  channel: string;
  firstPayload: unknown;
  secondPayload: unknown;
}

const SUBSCRIPTION_CASES: SubscriptionCase[] = [
  {
    apiName: "firefly",
    methodName: "onPetZoom",
    channel: IPC.PET_ZOOM,
    firstPayload: 1.25,
    secondPayload: 1.5,
  },
  {
    apiName: "appUpdate",
    methodName: "onStateChanged",
    channel: IPC.APP_UPDATE_STATE,
    firstPayload: { status: "checking" },
    secondPayload: { status: "available", version: "1.2.0" },
  },
  {
    apiName: "agui",
    methodName: "onEvent",
    channel: IPC.AGUI_EVENT,
    firstPayload: { type: "RUN_STARTED", runId: "run-1" },
    secondPayload: { type: "RUN_FINISHED", runId: "run-1" },
  },
  {
    apiName: "settings",
    methodName: "onSwitchSection",
    channel: IPC.SETTINGS_SWITCH_SECTION,
    firstPayload: "general",
    secondPayload: "models",
  },
  {
    apiName: "plugins",
    methodName: "onChanged",
    channel: IPC.PLUGINS_CHANGED,
    firstPayload: { plugins: [{ id: "alpha" }] },
    secondPayload: { plugins: [{ id: "alpha" }, { id: "beta" }] },
  },
];

describe("preload listener removal", () => {
  beforeEach(async () => {
    vi.resetModules();
    fixture.exposed.clear();
    fixture.listeners.clear();
    fixture.invoke.mockReset();
    fixture.send.mockReset();
    fixture.on.mockClear();
    fixture.off.mockClear();
    fixture.removeListener.mockClear();
    await import("../preload/index");
  });

  it.each(SUBSCRIPTION_CASES)(
    "$apiName#$methodName unsubscribes listener A without removing sibling listener B on $channel",
    ({ apiName, methodName, channel, firstPayload, secondPayload }) => {
      const api = fixture.exposed.get(apiName);
      expect(api).toBeDefined();
      expect(typeof api?.[methodName]).toBe("function");

      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = api![methodName](listenerA) as () => void;
      const unsubB = api![methodName](listenerB) as () => void;

      emit(channel, firstPayload);
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerA).toHaveBeenCalledWith(firstPayload);
      expect(listenerB).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledWith(firstPayload);

      unsubA();

      emit(channel, secondPayload);
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(2);
      expect(listenerB).toHaveBeenLastCalledWith(secondPayload);

      unsubB();
      emit(channel, secondPayload);
      expect(listenerB).toHaveBeenCalledTimes(2);
    },
  );

  it("uses removeListener instead of ipcRenderer.off across all preload sources", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const preloadRoot = path.join(repoRoot, "src/preload");
    const files = collectTsFiles(preloadRoot);
    expect(files.length).toBeGreaterThan(0);

    const matches: string[] = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((lineText, index) => {
        for (const _hit of lineText.matchAll(/ipcRenderer\.off\(/g)) {
          matches.push(`${rel}:${index + 1}: ${lineText.trim()}`);
        }
      });
    }

    expect(matches).toEqual([]);
  });
});
