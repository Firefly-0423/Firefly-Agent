import type { ChannelId } from "./types";

export type ChannelRateLimits = { perChannel: number; perUser: number };
export type CreateChannelRateLimiterOptions = { now?: () => number; limits: ChannelRateLimits };
export interface ChannelRateLimiter {
  reset(): void;
  reconfigure(limits: ChannelRateLimits): void;
  tryConsume(channel: ChannelId, senderId: string): boolean;
}
export function pruneExpiredRateLimitBuckets(buckets: Map<string, number[]>, now: number): void {
  for (const [bucketId, recorded] of buckets) {
    const retained = recorded.filter((instant) => now - instant < 60_000);
    if (retained.length === 0) buckets.delete(bucketId);
    else if (retained.length !== recorded.length) buckets.set(bucketId, retained);
  }
}
class QuotaLedger implements ChannelRateLimiter {
  private readonly ledger = new Map<string, number[]>();
  private quotas: ChannelRateLimits;
  constructor(options: CreateChannelRateLimiterOptions, private readonly clock = options.now ?? Date.now) { this.quotas = options.limits; }
  tryConsume(channel: ChannelId, senderId: string): boolean {
    const instant = this.clock();
    this.pruneExpired(instant);
    const personId = `${channel}:${senderId}`;
    const platformId = `__channel__:${channel}`;
    const person = this.ledger.get(personId) ?? [];
    const platform = this.ledger.get(platformId) ?? [];
    if (person.length >= this.quotas.perUser || platform.length >= this.quotas.perChannel) return false;
    person.push(instant);
    platform.push(instant);
    this.ledger.set(personId, person);
    this.ledger.set(platformId, platform);
    return true;
  }
  reconfigure(limits: ChannelRateLimits): void { this.quotas = limits; this.reset(); }
  reset(): void { this.ledger.clear(); }
  private pruneExpired(instant: number): void { pruneExpiredRateLimitBuckets(this.ledger, instant); }
}
export function createChannelRateLimiter(options: CreateChannelRateLimiterOptions): ChannelRateLimiter { return new QuotaLedger(options); }
