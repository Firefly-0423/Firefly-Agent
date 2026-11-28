import { expect, it } from "vitest";
import { createChannelRateLimiter, pruneExpiredRateLimitBuckets } from "./rate-limiter";

it("does not charge a sender for a request denied by the channel quota", () => {
  let clock = 100;
  const limiter = createChannelRateLimiter({ now: () => clock, limits: { perChannel: 2, perUser: 2 } });
  expect(limiter.tryConsume("qq", "early-a")).toEqual(true);
  clock++;
  expect(limiter.tryConsume("qq", "early-b")).toEqual(true);
  clock = 59_100;
  expect(limiter.tryConsume("qq", "late-arrival")).toEqual(false);
  clock = 60_102;
  expect(limiter.tryConsume("qq", "late-arrival")).toEqual(true);
  expect(limiter.tryConsume("qq", "late-arrival")).toEqual(true);
});

it("drops expired buckets and only the expired entries of a mixed bucket", () => {
  const windows = new Map([["stale", [50]], ["partial", [50, 30_051]], ["recent", [30_052]]]);
  pruneExpiredRateLimitBuckets(windows, 60_051);
  expect(windows).toStrictEqual(new Map([["partial", [30_051]], ["recent", [30_052]]]));
});

it("expires an event at exactly sixty seconds", () => {
  const windows = new Map([["edge", [0, 1]]]);
  pruneExpiredRateLimitBuckets(windows, 60_000);
  expect(windows).toStrictEqual(new Map([["edge", [1]]]));
});

it("starts a fresh quota window when limits are reconfigured", () => {
  const limiter = createChannelRateLimiter({ limits: { perUser: 1, perChannel: 1 } });
  expect(limiter.tryConsume("qq", "speaker")).toEqual(true);
  expect(limiter.tryConsume("qq", "speaker")).toEqual(false);
  limiter.reconfigure({ perUser: 2, perChannel: 2 });
  expect(limiter.tryConsume("qq", "speaker")).toEqual(true);
  expect(limiter.tryConsume("qq", "speaker")).toEqual(true);
});
