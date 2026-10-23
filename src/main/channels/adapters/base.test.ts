import { describe, expect, it } from "vitest";
import * as adapters from "./base";

// Optional lookup keeps the RED assertion focused on the missing authority, not an import error.
const signalFor = (identity: unknown): AbortSignal | null => (
  adapters as typeof adapters & { getChannelMemoryAccountSignal?: (value: unknown) => AbortSignal | null }
).getChannelMemoryAccountSignal?.(identity) ?? null;

describe("Main channel memory account cancellation", () => {
  it("associates a private signal with each genuine frozen snapshot", () => {
    const account = adapters.createChannelMemoryAccountIdentity();
    expect(account.read()).toBeNull();
    account.authenticate("qqbot:synthetic-app");
    const identity = account.read()!;
    const signal = signalFor(identity);

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(signalFor(identity)).toBe(signal);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Reflect.ownKeys(identity)).toEqual(["accountKey", "revision"]);
    expect(JSON.parse(JSON.stringify(identity))).toEqual(identity);
  });

  it("revokes synchronously before notifying listeners and keeps the old signal aborted", () => {
    const account = adapters.createChannelMemoryAccountIdentity();
    account.authenticate("qq:123");
    const identity = account.read()!;
    const signal = signalFor(identity);
    expect(signal).not.toBeNull();
    const snapshotsAtAbort: unknown[] = [];
    signal!.addEventListener("abort", () => snapshotsAtAbort.push(account.read()));

    account.revoke();
    expect(signal!.aborted).toBe(true);
    expect(signalFor(identity)).toBe(signal);
    expect(snapshotsAtAbort).toEqual([null]);
    account.revoke();
    expect(snapshotsAtAbort).toEqual([null]);
  });

  it("preserves repeat authentication and aborts on replacement or reconnect", () => {
    const account = adapters.createChannelMemoryAccountIdentity();
    account.authenticate("feishu:app-a");
    const first = account.read()!;
    const firstSignal = signalFor(first);
    expect(firstSignal).not.toBeNull();
    account.authenticate("feishu:app-a");
    expect(account.read()).toBe(first);
    expect(firstSignal!.aborted).toBe(false);

    let snapshotAtReplacement: unknown;
    firstSignal!.addEventListener("abort", () => { snapshotAtReplacement = account.read(); });
    account.authenticate("feishu:app-b");
    const second = account.read()!;
    expect(firstSignal!.aborted).toBe(true);
    expect(snapshotAtReplacement).toBeNull();
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(signalFor(second)?.aborted).toBe(false);

    account.revoke();
    account.authenticate("feishu:app-b");
    expect(signalFor(second)?.aborted).toBe(true);
    expect(account.read()).not.toBe(second);
    expect(signalFor(account.read())?.aborted).toBe(false);
  });

  it("fails closed for JSON clones, lookalikes, primitives and missing identity", () => {
    const account = adapters.createChannelMemoryAccountIdentity();
    account.authenticate("wechat:synthetic-bot");
    const identity = account.read()!;
    expect(signalFor(identity)).not.toBeNull();
    for (const forged of [JSON.parse(JSON.stringify(identity)), { ...identity }, Object.create(identity), {}, null, undefined, "wechat:synthetic-bot", 1]) {
      expect(signalFor(forged)).toBeNull();
    }
  });

  it("does not revive an account when an abort listener cancels a replacement", () => {
    const account = adapters.createChannelMemoryAccountIdentity();
    account.authenticate("qq:123");
    const signal = signalFor(account.read());
    expect(signal).not.toBeNull();
    signal!.addEventListener("abort", () => account.revoke());
    account.authenticate("qq:456");
    expect(account.read()).toBeNull();
  });
});
