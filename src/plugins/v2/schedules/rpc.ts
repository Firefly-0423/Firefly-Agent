import {
  PLUGIN_TO_HOST_METHODS as P,
  PluginError,
  type ProtocolScheduleTriggerChunk,
} from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import type { PluginScheduleService } from "./schedule-service";
import type { ScheduleProposalSpec } from "./types";

export interface BindPluginScheduleRpcOptions {
  pluginId: string;
  declared: boolean;
  hasPermission: () => boolean;
}

function assertObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid schedules RPC arguments");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Unexpected field in schedules RPC arguments");
  }
  return record;
}

/**
 * Attaches `schedules.*` RPC handlers for a single v2 plugin process.
 * Revocation or disposal aborts active trigger subscriptions and rejects subsequent calls with `ERR_PERMISSION`.
 */
export function bindPluginScheduleRpc(
  service: PluginScheduleService,
  options: BindPluginScheduleRpcOptions,
  rpc: PluginRpc,
): () => void {
  const stopController = new AbortController();
  const client = service.forPlugin(options.pluginId, {
    signal: stopController.signal,
    hasPermission: () => {
      if (!options.declared) {
        throw new PluginError("ERR_UNDECLARED", 'Permission "schedules" is not declared in manifest');
      }
      return options.hasPermission();
    },
  });

  const assertPermitted = (): void => {
    if (!options.declared) {
      throw new PluginError("ERR_UNDECLARED", 'Permission "schedules" is not declared in manifest');
    }
    if (!options.hasPermission()) {
      throw new PluginError("ERR_PERMISSION", 'Permission "schedules" is not granted');
    }
  };

  const stops = [
    rpc.handle(P.schedulesPropose, async (params) => {
      assertPermitted();
      return client.propose(params as ScheduleProposalSpec);
    }),
    rpc.handle(P.schedulesUpdate, async (params) => {
      assertPermitted();
      const input = assertObject(params, ["taskId", "patch"]);
      return client.update(input.taskId as string, input.patch as Partial<ScheduleProposalSpec>);
    }),
    rpc.handle(P.schedulesRemove, async (params) => {
      assertPermitted();
      const input = assertObject(params, ["taskId"]);
      return client.remove(input.taskId as string);
    }),
    rpc.handle(P.schedulesList, async (params) => {
      assertPermitted();
      assertObject(params ?? {}, []);
      return client.list();
    }),
    rpc.handle(P.schedulesOnTrigger, (params, { signal }) => {
      assertPermitted();
      assertObject(params ?? {}, []);
      return (async function* (): AsyncIterable<ProtocolScheduleTriggerChunk> {
        const queue: ProtocolScheduleTriggerChunk[] = [];
        let wake = () => {};
        let closed = false;
        const sub = client.onTrigger((event) => {
          queue.push({
            taskId: event.taskId,
            ...(event.payload !== undefined ? { payload: event.payload } : {}),
          });
          wake();
        });
        const onAbort = () => {
          closed = true;
          wake();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        stopController.signal.addEventListener("abort", onAbort, { once: true });
        try {
          while (!closed && !signal.aborted && !stopController.signal.aborted) {
            assertPermitted();
            if (queue.length === 0) {
              await new Promise<void>((resolve) => { wake = resolve; });
              continue;
            }
            while (queue.length > 0) {
              yield queue.shift()!;
            }
          }
        } finally {
          sub.dispose();
          signal.removeEventListener("abort", onAbort);
          stopController.signal.removeEventListener("abort", onAbort);
        }
      })();
    }),
  ];

  return () => {
    stopController.abort("disposed");
    for (const stop of stops) stop();
  };
}
