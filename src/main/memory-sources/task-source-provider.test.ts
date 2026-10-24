import { expect, it, vi } from "vitest";
import { contextFixture } from "../../../scripts/verify/memory-context/context-fixture";
import { createBackgroundMemoryIngressIssuer } from "../memory-context/background-memory-ingress";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { createMainUserFactCoordinator } from "../memory-policy/main-user-fact-coordinator";
import { requireMainSourceProvider } from "./main-source-provider";
import { createTaskSourceProvider } from "./task-source-provider";

async function fixture(entry: "scheduler" | "child" | "proactive") {
  const f = await contextFixture(), store = new ConversationTranscriptStore(f.root), source = {};
  const controller = new AbortController(), ownerController = new AbortController();
  const issuer = createBackgroundMemoryIngressIssuer({ entry, isCurrent: item => item === source });
  const ingress = issuer.capture({ source, sessionId: "task-session", sourceKey: "task-source", instructionText: "I prefer PowerShell", signal: controller.signal });
  const provider = createTaskSourceProvider({ providerId: "synthetic", store, signal: ownerController.signal });
  provider.attach(ingress, "scope-a");
  const identity = { providerId: "synthetic", sessionId: "task-session", messageId: "instruction-1" };
  const actor = f.actorAuthority.bindActor(f.access, provider.token, identity);
  return { ...f, store, provider, ingress, identity, actor, controller, ownerController,
    commit: () => provider.commitInstruction(ingress, { messageId: identity.messageId, instructionText: "I prefer PowerShell", scopeKey: "scope-a" }) };
}
it.each(["scheduler", "child", "proactive"] as const)("%s commits an explicit non-user source while retaining canonical user wire framing", async entry => {
  const f = await fixture(entry); await f.commit();
  const ref = await f.registry.capture(f.access, f.provider.token, f.identity);
  expect(f.registry.resolveVerifiedSource(ref)).toMatchObject({ sourceTrust: entry === "child" ? "model" : "system", kind: entry === "child" ? "assistant" : "system" });
  expect((await f.store.read("task-session")).entries).toMatchObject([{ kind: "user", payload: { text: "I prefer PowerShell" } }]);
  const coordinator = createMainUserFactCoordinator({ actorAuthority: f.actorAuthority, registry: f.registry, policy: f.policy });
  await expect(coordinator.onCommittedUserSource(f.actor, ref)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");
  expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("requires proof and exact text, pins scope, and never infers trust from historical wire role", async () => {
  const f = await fixture("scheduler");
  expect(() => f.provider.attach({} as never, "scope-a")).toThrow("MEMORY_BACKGROUND_INGRESS_DENIED");
  expect(() => f.provider.attach(f.ingress, "desktop-owner")).toThrow("MEMORY_TASK_SOURCE_DENIED");
  await expect(f.provider.commitInstruction(f.ingress, { messageId: "instruction-1", instructionText: "changed", scopeKey: "scope-a" })).rejects.toThrow("MEMORY_TASK_SOURCE_DENIED");
  await f.store.append("task-session", { id: "legacy", kind: "user", turnId: "instruction-1", revision: 1, payload: { text: "I prefer PowerShell" } });
  await expect(f.registry.capture(f.access, f.provider.token, f.identity)).rejects.toThrow("MEMORY_TASK_SOURCE_DENIED");
  await expect(f.commit()).rejects.toThrow("MEMORY_TASK_SOURCE_DENIED");
});
it("restores only encrypted source heads and rejects reuse and revoked producers", async () => {
  const f = await fixture("child"); await f.commit();
  const ref = await f.registry.capture(f.access, f.provider.token, f.identity);
  const restored = createTaskSourceProvider({ providerId: "synthetic", store: f.store }); restored.attach(f.ingress, "scope-a");
  expect(await f.registry.readEvidence(f.access, restored.token, ref)).toBe("I prefer PowerShell");
  await expect(f.commit()).rejects.toThrow("MEMORY_TASK_SOURCE_DENIED");
  f.controller.abort();
  await expect(f.registry.readEvidence(f.access, restored.token, ref)).rejects.toThrow();
});

it.each([
  ["read", "abort"], ["read", "close"], ["commit", "abort"], ["commit", "close"],
] as const)("denies a canonical %s suspended across provider %s and drains the real operation", async (phase, stop) => {
  const f = await fixture("scheduler");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  if (phase === "read") {
    const read = f.store.read.bind(f.store);
    vi.spyOn(f.store, "read").mockImplementationOnce(async id => { const result = await read(id); entered(); await held; return result; });
  } else {
    f.store.observeMutations("task-session", async () => { entered(); await held; });
  }
  const commandCount = f.commands.length;
  const pending = f.commit(); await ready;
  let drained = false;
  if (stop === "abort") f.ownerController.abort();
  const closing = stop === "close" ? f.provider.close().then(() => { drained = true; }) : undefined;
  await Promise.resolve(); expect(drained).toBe(false);
  release();
  await expect(pending).rejects.toThrow("MEMORY_TASK_SOURCE_DENIED");
  await closing;
  expect((await f.store.read("task-session")).entries).toEqual([]);
  expect(f.commands).toHaveLength(commandCount);
  if (stop === "close") expect(drained).toBe(true);
});

it("revokes an already-open source lease when the captured owner lifetime aborts", async () => {
  const f = await fixture("child"); await f.commit();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const provider = requireMainSourceProvider(f.provider.token, "scope-a", f.identity);
  const pending = provider.withLease(f.identity, async read => { await read(); entered(); await held; return "must not escape"; });
  await ready; f.ownerController.abort(); release();
  await expect(pending).rejects.toThrow("MEMORY_TASK_SOURCE_DENIED");
  await f.provider.close();
});
