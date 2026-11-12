// 每个任务的失败单独交还调用者，后面的任务仍按入队顺序运行。
let completed: Promise<unknown> = Promise.resolve();
const backoffMs = 5_000;
const queueTag = "[LLMQueue]";

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function canRetry(failure: unknown): boolean {
  const detail = describeFailure(failure).toLowerCase();
  return ["rate limit", "速率限制", "频率", "too many requests", "429", "rate_limit", "ratelimit"]
    .some((needle) => detail.includes(needle.toLowerCase()));
}

async function executeQueued<T>(
  title: string, invoke: () => Promise<T>, verbose: boolean, retryAllowed: boolean,
): Promise<T> {
  const began = Date.now();
  if (verbose) console.log(queueTag, "开始执行:", title);
  try {
    const value = await invoke();
    if (verbose) console.log(queueTag, "完成:", title, `耗时=${Date.now() - began}ms`);
    return value;
  } catch (failure) {
    if (!retryAllowed || !canRetry(failure)) {
      if (verbose) console.warn(queueTag, "失败（非限流，不重试）:", title, describeFailure(failure));
      throw failure;
    }
    if (verbose) console.warn(queueTag, `限流，${backoffMs / 1000}s 后重试 1 次:`, title);
    await new Promise((done) => setTimeout(done, backoffMs));
    try {
      const recovered = await invoke();
      if (verbose) console.log(queueTag, "重试成功:", title, `总耗时=${Date.now() - began}ms`);
      return recovered;
    } catch (lastFailure) {
      if (verbose) console.error(queueTag, "重试仍失败，放弃:", title, describeFailure(lastFailure));
      throw lastFailure;
    }
  }
}

export function enqueueLLMTask<T>(
  label: string, task: () => Promise<T>,
  options: { log?: boolean; retryRateLimit?: boolean } = {},
): Promise<T> {
  const scheduled = completed.then(async (): Promise<T> => {
    return executeQueued(label, task, options.log !== false, options.retryRateLimit !== false);
  });
  completed = scheduled.catch(() => undefined);
  return scheduled;
}
