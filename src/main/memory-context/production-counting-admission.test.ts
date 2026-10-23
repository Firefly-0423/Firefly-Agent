import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSmhFixture } from "./smh-fixture.test-support";
import { createMainContext } from "./main-context";
import { resolveMemoryCounter } from "./model-counting";
import { RecordCodec } from "../memory-core/record-codec";
import type { ContextUnit, PreparedRequest } from "./context-contracts";
const fixtures: ReturnType<typeof createSmhFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.close(); fs.rmSync(f.root, { recursive: true, force: true }); } });
function fixture(transport: "openai" | "responses" | "anthropic") {
 const f = createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-production-budget-"))); fixtures.push(f);
 const counter = resolveMemoryCounter({ provider: "Synthetic", baseUrl: "https://configured.invalid/v1", model: "synthetic-configured-model", apiKey: "synthetic", explicitTransport: transport }, 1);
 const { providerId, model, framingVersion } = counter.capability;
 const prepare = (units: ContextUnit[]): PreparedRequest => ({ providerId, model, transport, framingVersion, inputTypes: ["text"], body: { model, messages: units.flatMap(u => u.messages) } });
 const context = createMainContext({ registry: f.registry, actorAuthority: f.actorAuthority, transport: f.transport, counter,
  clock: () => 1700000000000, prepare, prepareS: prepare,
  budget: { admissionMode: "bounded", maxContextTokens: 2000000, reservedOutputTokens: 8192, safetyMarginTokens: 512, maxSTokens: 10000, minRecentCompleteTurns: 1 } });
 return { ...f, context };
}
it.each(["openai", "responses", "anthropic"] as const)("stores explicitly estimated production admission for configured %s transport", async transport => {
 const f = fixture(transport), s = await f.source("Synthetic user statement"), snapshot = await f.context.assemble(f.actor, { sessionId: "session-a", sourceRefs: [s.ref] });
 expect(snapshot.admissionMode).toBe("bounded"); expect(snapshot.estimates?.selectionInputLimit).toBe(1991296);
 const db = new DatabaseSync(f.databasePath);
 try {
  const row = db.prepare("SELECT payload FROM context_records WHERE id=?").get(snapshot.snapshotId)!;
  const saved = new RecordCodec(f.key).open<any>("context-snapshot", "scope-a", snapshot.snapshotId, row.payload);
  expect(saved.counterIdentity.mode).toBe("estimate"); expect(saved.estimates.selectionInputLimit).toBe(1991296);
  expect(saved.promptTokens).toBeUndefined(); expect(saved.inputLimit).toBeUndefined();
 } finally { db.close(); }
});
it("production estimates retain single-use sends and source-change rejection", async () => {
 const f = fixture("openai"), s = await f.source("Synthetic user statement");
 const assemble = () => f.context.assemble(f.actor, { sessionId: "session-a", sourceRefs: [s.ref] });
 const permit = await f.context.validateForDispatch(f.actor, await assemble()); let sends = 0;
 await f.context.dispatch(f.actor, permit, () => { sends++; return "synthetic-result"; });
 await expect(f.context.dispatch(f.actor, permit, () => { sends++; })).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");
 const next = await f.context.validateForDispatch(f.actor, await assemble());
 await f.registry.prepareChange(f.access, f.adapter, s.ref);
 await expect(f.context.dispatch(f.actor, next, () => { sends++; })).rejects.toThrow(); expect(sends).toBe(1);
});
it("rejects unsupported production estimator versions instead of accepting arbitrary estimate claims", async () => {
 const f = fixture("openai"), s = await f.source("Synthetic user statement");
 await f.context.assemble(f.actor, { sessionId: "session-a", sourceRefs: [s.ref] });
 const command = structuredClone(f.commands.find((c: any) => c.kind === "snapshot")) as any;
 command.commandId = randomUUID(); command.body.snapshotId = randomUUID(); command.body.counterIdentity.framingVersion = "unreviewed-estimator";
 expect(() => f.repo.contextCommand(command)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
});
it("does not admit an unknown production estimator under the legacy OpenRouter exception", async () => {
 const f = fixture("responses"), s = await f.source("Synthetic user statement");
 await f.context.assemble(f.actor, { sessionId: "session-a", sourceRefs: [s.ref] });
 const command = structuredClone(f.commands.find((c: any) => c.kind === "snapshot")) as any;
 command.commandId = randomUUID(); command.body.snapshotId = randomUUID();
 Object.assign(command.body.counterIdentity, { providerId: "openrouter", model: "openai/gpt-6-luna", framingVersion: "firefly-prepared-estimate-v99:responses:1:0123456789abcdef" });
 command.body.estimates.selectionInputLimit = 10000;
 expect(() => f.repo.contextCommand(command)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
});
