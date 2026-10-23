export type CreateKeyedQueueOptions = { maxPendingPerKey?: number };
export interface KeyedQueue { run<T>(key: string, task: () => Promise<T>): Promise<T>; }

class ConversationQueue implements KeyedQueue {
  private readonly lanes = new Map<string, { settled: Promise<void>; count: number }>();
  constructor(private readonly capacity: number) {}
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) { lane = { settled: Promise.resolve(), count: 0 }; this.lanes.set(key, lane); }
    if (lane.count >= this.capacity) return Promise.reject(new Error(`queue_full:${key}`));
    lane.count += 1;
    const completion = lane.settled.then(task).finally(() => {
      lane.count -= 1;
      if (lane.count === 0 && this.lanes.get(key) === lane) this.lanes.delete(key);
    });
    // 队尾只负责排序，调用方仍会收到任务本身的异常。
    lane.settled = completion.then(() => undefined, () => undefined);
    return completion;
  }
}
export function createKeyedQueue(options: CreateKeyedQueueOptions = {}): KeyedQueue {
  return new ConversationQueue(options.maxPendingPerKey ?? 20);
}
