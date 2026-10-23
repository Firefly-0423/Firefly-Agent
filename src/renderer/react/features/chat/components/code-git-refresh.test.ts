import { expect, test, vi } from "vitest";
import { createCodeGitRefreshController } from "./code-git-refresh";

const drain = () => new Promise<void>((done) => setTimeout(done, 0));

test("serializes a burst into the active refresh and one queued refresh", async () => {
  let complete!: (value: string) => void;
  const first = new Promise<string>((done) => { complete = done; });
  const load = vi.fn().mockReturnValueOnce(first).mockResolvedValue("updated");
  const apply = vi.fn(), busy = vi.fn(), failed = vi.fn();
  const refresh = createCodeGitRefreshController({ busy, failed, apply, load });
  for (let request = 0; request < 6; request++) refresh.request();
  expect(load.mock.calls).toStrictEqual([[]]);
  expect(busy.mock.calls).toStrictEqual([[true]]);
  complete("initial");
  await drain();
  expect(load.mock.calls).toStrictEqual([[], []]);
  expect(apply.mock.calls).toStrictEqual([["initial"], ["updated"]]);
  expect(busy.mock.calls).toStrictEqual([[true], [false], [true], [false]]);
  expect(failed).not.toHaveBeenCalled();
  refresh.dispose();
});

test("reports rejection and allows another refresh", async () => {
  const failed = vi.fn(), apply = vi.fn(), busy = vi.fn();
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(17);
  const refresh = createCodeGitRefreshController({ apply, busy, load, failed });
  refresh.request();
  await drain();
  expect(failed.mock.calls).toStrictEqual([[]]);
  expect(apply).not.toHaveBeenCalled();
  refresh.request();
  await drain();
  expect(apply.mock.calls).toStrictEqual([[17]]);
  refresh.dispose();
});

test("disposal drops pending work and late results", async () => {
  let finish!: (value: number) => void;
  const load = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
  const apply = vi.fn(), failed = vi.fn(), busy = vi.fn();
  const refresh = createCodeGitRefreshController({ load, apply, failed, busy });
  refresh.request();
  refresh.request();
  refresh.dispose();
  finish(99);
  await drain();
  refresh.request();
  expect(load).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(busy.mock.calls).toStrictEqual([[true]]);
});
