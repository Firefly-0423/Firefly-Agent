import { randomUUID } from "node:crypto";
import type {
  PluginSchedulerFinishedEvent,
  PluginToolFinishedEvent,
  PluginTurnFinishedEvent,
  PluginTurnStartedEvent,
} from "../../plugins/api";

type StampKey = "eventId" | "timestamp";

// 对联合类型逐个分支去掉元数据字段，保留每个来源分支自己的字段。
type OmitStamp<T> = T extends unknown ? Omit<T, StampKey> : never;

export type TurnStartedInput = OmitStamp<PluginTurnStartedEvent>;
export type TurnFinishedInput = OmitStamp<PluginTurnFinishedEvent>;
export type SchedulerFinishedInput = Omit<PluginSchedulerFinishedEvent, StampKey>;
export type ToolFinishedInput = Omit<PluginToolFinishedEvent, StampKey>;

export interface LifecyclePublisherDeps {
  /** 宿主事件总线入口（即 PluginManager.publishHostEvent），调用后不等待监听器。 */
  publish: (event: string, payload: unknown) => Promise<void>;
  /** 可注入的事件 id 生成器，缺省为随机 UUID。 */
  eventId?: () => string;
  /** 可注入的时钟，缺省为当前时间。 */
  now?: () => Date;
}

export interface LifecyclePublisher {
  publishTurnStarted(event: TurnStartedInput): void;
  publishTurnFinished(event: TurnFinishedInput): void;
  publishSchedulerFinished(event: SchedulerFinishedInput): void;
  publishToolFinished(event: ToolFinishedInput): void;
}

/**
 * 生命周期事件发布器。事件只做即时广播，不落盘也不补发；
 * 发布失败只留下一条告警，绝不影响调用方。
 */
export function createLifecyclePublisher(deps: LifecyclePublisherDeps): LifecyclePublisher {
  const makeEventId = deps.eventId ?? (() => randomUUID());
  const readClock = deps.now ?? (() => new Date());

  function emit(eventName: string, body: Record<string, unknown>): void {
    // 宿主元数据最后覆盖，调用方传入的同名字段会被忽略。
    const envelope = { ...body, eventId: makeEventId(), timestamp: readClock().toISOString() };
    deps.publish(eventName, envelope).catch((failure) => {
      console.warn(`[plugins] 发布宿主事件 ${eventName} 失败`, failure);
    });
  }

  return {
    publishTurnStarted(event) {
      emit("turn:started", { ...event });
    },
    publishTurnFinished(event) {
      emit("turn:finished", { ...event });
    },
    publishSchedulerFinished(event) {
      emit("scheduler:finished", { ...event });
    },
    publishToolFinished(event) {
      emit("tool:finished", { ...event });
    },
  };
}
