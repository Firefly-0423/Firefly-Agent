import { expect, it } from "vitest";
import { createMainActorAuthority } from "../memory-core/main-actor-authority";
import { createMainMemoryAuthority } from "../memory-core/main-access";
import { createMainSourceProvider } from "../memory-sources/main-source-provider";
import { createMemorySessionModes } from "./memory-session-modes";
import * as contracts from "./main-memory-contracts";

function fixture(mode: "persistent" | "temporary" = "persistent") {
  const access = createMainMemoryAuthority({ policyVersion: "test-v1", resolveSource: () => null }).access("scope-a");
  let reads = 0, profileRevision = 1, entryRevision = 1, accountKey: string | undefined, entrySignal: AbortSignal | undefined;
  const actors = createMainActorAuthority({ resolveActor: (_scope, identity) => identity.sessionId === "foreign" ? "owner-b" : "owner-a" });
  function actor(sessionId: string) {
    const identity = { providerId: "test-provider", sessionId, messageId: "turn-a" };
    const source = createMainSourceProvider({ providerId: identity.providerId, authorize: (scope, value) => scope === "scope-a" && value.sessionId === sessionId,
      withLease: async () => { reads++; throw Error("NO_SOURCE_READ_EXPECTED"); } });
    return { source, token: actors.bindActor(access, source, identity, { sessionMode: mode }) };
  }
  const main = actor("session-a"), sibling = actor("session-b"), foreign = actor("foreign");
  const modes = createMemorySessionModes(); modes.bind("session-a", mode);
  const profiles = Object.freeze({ primary: "model-a", secondary: "model-b" });
  const create = (contracts as Record<string, unknown>).createMemoryRunAuthority;
  expect(create).toBeTypeOf("function");
  const authority = (create as (options: unknown) => any)({ actors, sessionModes: modes,
    resolveProfile: (id: string) => Object.hasOwn(profiles, id) ? { id, revision: profileRevision } : null,
    resolveEntry: () => ({ revision: entryRevision, ...(accountKey ? { accountKey } : {}), ...(entrySignal ? { signal: entrySignal } : {}) }),
    canRead: (from: { actorKey: string }, to: { actorKey: string }) => from.actorKey === to.actorKey,
  });
  const controller = new AbortController();
  const input = { identity: { entry: "desktop", sessionId: "session-a", runId: "run-a", modelProfileId: "secondary", sessionMode: mode }, actorToken: main.token, sourceProvider: main.source, readActorTokens: mode === "persistent" ? [sibling.token] : [], signal: controller.signal };
  return { authority, input, controller, modes, main, sibling, foreign, profiles, reads: () => reads,
    changeProfile: () => { profileRevision++; }, changeEntry: () => { entryRevision++; }, setEntrySignal: (value: AbortSignal) => { entrySignal = value; }, setAccount: (value?: string) => { accountKey = value; } };
}
it("accepts a saved non-default profile without reading source bodies or changing configuration", () => {
  const f = fixture(), before = JSON.stringify(f.profiles), grant = f.authority.issue(f.input);
  expect(f.authority.require(grant).identity.modelProfileId).toBe("secondary");
  expect(JSON.stringify(f.profiles)).toBe(before); expect(f.reads()).toBe(0);
  expect(JSON.stringify(grant)).toBe("{}"); expect(Object.isFrozen(grant)).toBe(true);
});
it("rejects forged grants, actor objects and source-provider substitutions", () => {
  const f = fixture(), grant = f.authority.issue(f.input);
  expect(() => f.authority.require(JSON.parse(JSON.stringify(grant)))).toThrow("MEMORY_RUN_DENIED");
  expect(() => f.authority.issue({ ...f.input, actorToken: {} })).toThrow("MEMORY_ACTOR_DENIED");
  expect(() => f.authority.issue({ ...f.input, sourceProvider: f.sibling.source })).toThrow("MEMORY_RUN_SOURCE_DENIED");
});
it("requires registered session mode, matching actor session and a saved model profile", () => {
  const f = fixture();
  expect(() => f.authority.issue({ ...f.input, identity: { ...f.input.identity, sessionMode: "temporary" } })).toThrow("MEMORY_RUN_IDENTITY_DENIED");
  expect(() => f.authority.issue({ ...f.input, identity: { ...f.input.identity, sessionId: "session-b" } })).toThrow();
  expect(() => f.authority.issue({ ...f.input, identity: { ...f.input.identity, modelProfileId: "missing" } })).toThrow("MEMORY_RUN_PROFILE_DENIED");
  f.modes.remove("session-a"); expect(() => f.authority.issue(f.input)).toThrow("MEMORY_SESSION_MODE_DENIED");
});
it("checks every read actor and prevents persistent read grants in a temporary session", () => {
  const f = fixture();
  expect(() => f.authority.issue({ ...f.input, readActorTokens: [f.foreign.token] })).toThrow("MEMORY_RUN_READ_DENIED");
  const t = fixture("temporary");
  expect(t.authority.require(t.authority.issue(t.input)).readActorTokens).toHaveLength(0);
  expect(() => t.authority.issue({ ...t.input, readActorTokens: [t.main.token] })).toThrow("MEMORY_RUN_READ_DENIED");
});
it("revokes grants after cancellation, explicit close, profile changes and session recreation", () => {
  for (const change of ["cancel", "close", "profile", "session", "entry"] as const) {
    const f = fixture(), grant = f.authority.issue(f.input);
    if (change === "cancel") f.controller.abort();
    if (change === "close") f.authority.revoke(grant);
    if (change === "profile") f.changeProfile();
    if (change === "entry") f.changeEntry();
    if (change === "session") { f.modes.remove("session-a"); f.modes.bind("session-a", "persistent"); }
    expect(() => f.authority.require(grant)).toThrow();
    expect(f.reads()).toBe(0);
  }
});
it("requires a host account identity for channel runs and rejects reconnect/account drift", () => {
  const f = fixture(), input = { ...f.input, identity: { ...f.input.identity, entry: "channel" } };
  expect(() => f.authority.issue(input)).toThrow("MEMORY_RUN_ACCOUNT_DENIED");
  f.setAccount("wechat:account-a"); const grant = f.authority.issue(input);
  expect(f.authority.require(grant).accountKey).toBe("wechat:account-a");
  f.setAccount("wechat:account-b"); expect(() => f.authority.require(grant)).toThrow("MEMORY_RUN_ENTRY_CHANGED");
});
it("copies identity and read scope so caller mutations cannot expand an issued grant", () => {
  const f = fixture(), grant = f.authority.issue(f.input);
  f.input.identity.modelProfileId = "primary"; f.input.readActorTokens.push(f.foreign.token);
  const context = f.authority.require(grant);
  expect(context.identity.modelProfileId).toBe("secondary");
  expect(context.readActorTokens).toEqual([f.sibling.token]);
  expect(Object.isFrozen(context.identity)).toBe(true); expect(Object.isFrozen(context.readActorTokens)).toBe(true);
});

it("entry revocation and explicit close synchronously abort the live run signal", () => {
 const f = fixture(), entry = new AbortController(); f.setEntrySignal(entry.signal);
 const grant = f.authority.issue(f.input), runSignal = f.authority.require(grant).signal;
 expect(runSignal.aborted).toBe(false); entry.abort(); expect(runSignal.aborted).toBe(true);
 const second = fixture(), other = second.authority.issue(second.input), otherSignal = second.authority.require(other).signal;
 second.authority.revoke(other); expect(otherSignal.aborted).toBe(true);
});
it("a detected profile invalidation aborts ongoing work as well as denying reuse", () => {
 const f = fixture(), grant = f.authority.issue(f.input), signal = f.authority.require(grant).signal;
 f.changeProfile(); expect(() => f.authority.require(grant)).toThrow("MEMORY_RUN_PROFILE_CHANGED");
 expect(signal.aborted).toBe(true);
});

it("exposes the resolved profile revision and never trusts a caller-supplied revision", () => {
  const f = fixture();
  f.changeProfile();
  f.changeProfile();
  const grant = f.authority.issue({ ...f.input, profileRevision: 999 });
  const context = f.authority.require(grant);

  expect(context.profileRevision).toBe(3);
  expect(context.identity.modelProfileId).toBe("secondary");
  expect(Object.isFrozen(context)).toBe(true);
  expect(() => Object.defineProperty(context, "profileRevision", { value: 999 })).toThrow();
  expect(f.authority.require(grant).profileRevision).toBe(3);
  expect(() => f.authority.issue({
    ...f.input,
    identity: { ...f.input.identity, profileRevision: 999 },
  })).toThrow();
});

it("retains the issued profile revision while drift revokes the grant and a new grant captures the new version", () => {
  const f = fixture();
  const grant = f.authority.issue(f.input);
  const context = f.authority.require(grant);
  expect(context.profileRevision).toBe(1);

  f.changeProfile();
  expect(() => f.authority.require(grant)).toThrow("MEMORY_RUN_PROFILE_CHANGED");
  expect(context.signal.aborted).toBe(true);
  expect(context.profileRevision).toBe(1);
  expect(() => f.authority.require(grant)).toThrow("MEMORY_RUN_DENIED");
  expect(f.authority.require(f.authority.issue(f.input)).profileRevision).toBe(2);
});
