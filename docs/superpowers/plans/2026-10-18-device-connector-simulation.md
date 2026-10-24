# Device Connector Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prove safe simulated light/AC/curtain commands through the existing MCP host with exact authorization, durable pending state and correlated receipts.

**Architecture:** A fixture/controller owns domain validation, opaque sessions and journaled intent. A separately owned loopback SSE fixture connects through the existing MCP adapter and ToolRegistry; no generic manager/startup changes. Execute inline and run one fresh whole-branch review.

**Tech Stack:** Existing TypeScript, Node 24, AtomicJsonStore, StorageContext, installed @modelcontextprotocol/sdk 1.31.0, Vitest 4.1.11; no dependency changes.

**Spec:** docs/superpowers/specs/2026-10-18-device-connector-simulation-design.md

## Global Constraints
- Only test/smoke profiles with an isolationRoot; every public DTO has simulation:true.
- Fixed fixture IDs light/ac/curtain; exact action/value semantics in the spec, no coercion or unknown keys.
- Preview TTL 30,000 ms, maximum 32 previews and 128 journal operations; journal maximum 1,048,576 bytes.
- Immutable exact intent; trusted host confirmation is not an MCP tool. MCP execute accepts operationId only.
- Persist dispatching before send; after-send uncertainty is unknown, never auto-retried or rolled back.
- Reuse existing MCP adapter/registry/config conventions without modifying normal bootstrap, manager or approval policy.
- No real accounts/devices/credentials, external candidates, downloads/installs, new dependencies, packaging or remote mutation.
- User explicitly authorizes simulation execution once this concrete plan is ready; no duplicate stage-confirmation request.

## Review Focus
1. A registered MCP execute called directly or with allow_all must still require the stored exact dispatch authorization.
2. Cancellation/late receipt after disposal must not label a sent command not_applied or overwrite a new owner's state.
3. A valid-looking receipt for a different owner/epoch/device/intent must leave unknown without resending.
4. A symlink/hardlink/oversized/corrupt journal or a concurrent owner must fail before any fixture effect or external request.
5. AC setpoint changes and deferred/accepted commands must not be represented as room-temperature change or device application.

### Task 1: fixed contracts and isolated journal
**Files:** Create src/main/device-simulation/contracts.ts, journal.ts; tests contracts.test.ts, journal.test.ts.
**Interfaces:**
- contracts.ts exports DeviceId, Action, DeviceSnapshot, Intent, Receipt, Operation, JournalState, SessionGrant; createFixtures(), normalizeAction(deviceId, value), applyAction(snapshot, action), intentDigest(intentWithoutDigest), validJournal(value), validateReceipt(value, operation).
- journal.ts exports SimulationJournal(context:StorageContext), read(fallback:JournalState):JournalState, write(value:JournalState):void, close():void. Fixed profile-local file/lease only.
- Later controller consumes these exact types and deep-copy snapshots; no Electron import is needed.

- [x] Write contract tests: initial three fixtures, legal bounds, unknown/extra keys, wrong primitives/ranges, detached snapshots, AC target vs current temperature, closed exact receipt correlation.
- [x] Write journal tests: production/development/no-isolation refusal before writes, fixed isolated location, valid reload and backup, invalid existing data preserved, size/path/file-link rejection, concurrent owner refusal and normal close/reopen. This owns Review Focus 4.
- [x] Run isolated tests with filters device-simulation/contracts and device-simulation/journal. Expected RED before implementation; record actual assertions/import error.
- [x] Implement only the named contracts/journal with the spec's fixed limits, AtomicJsonStore and exclusive profile-local lease; no stale-lock auto-removal.
- [x] Run the same filters and Main compile. Expected all pass/exit0. Commit feat(devices): define bounded simulator contracts and journal.

### Task 2: exact authorization and durable command lifecycle
**Files:** Create src/main/device-simulation/controller.ts and controller.test.ts.
**Interfaces:**
- new DeviceSimulation(context:StorageContext, options?:{now?:()=>number; deferredDeviceIds?:readonly DeviceId[]})
- openSession(grant:SessionGrant):SimulationSession; revokeSession(session):void; read(session,deviceId):DeviceSnapshot; preview(session,deviceId,action):Preview.
- assertReady(session:SimulationSession):void is the shared read-only durable health/ownership checkpoint used by receipt queries and the fixture protocol wrapper.
- confirm(session,previewId):OperationView; dispatch(session,operationId,port:McpDevicePort,signal?:AbortSignal):Promise<OperationView>; reconcile(session,operationId,port,signal?):Promise<OperationView>; pending(session):OperationView[]; cancel(session,operationId):OperationView; close():void.
- handleMcp(session,name:read|preview|execute|receipt,args:unknown):unknown validates exact args and independently gates fixture execution.
- completeFixture(operationId):void is a trusted simulation-harness method, absent from MCP tools.
- McpDevicePort has execute(id,signal?):Promise<unknown> and receipt(id,signal?):Promise<unknown>. Only nonsecret IDs travel to MCP; unit ports can inject transport faults.

- [x] Write tests for default deny, opaque-session forgery, per-owner/device/action grants, preview no journal/effect change, forged preview data, expiry/revocation/stale revision, exact confirmation and consume-once.
- [x] Write tests for persist-before-send failure with zero provider calls, duplicate/simultaneous dispatch, direct MCP bypass rejection, deferred accepted vs applied, bounded unresolved capacity.
- [x] Write loss/cancellation/receipt tests: apply then lose acknowledgement -> unknown; close/reconstruct -> receipt-only reconciliation, zero execute resend; before-send abort vs after-send abort; every wrong correlation field/malformed receipt -> unknown; disposal late response cannot write to next owner. These own Review Focus 1,2,3,5.
- [x] Run filter device-simulation/controller. Expected RED before controller exists.
- [x] Implement the exact interfaces with serialized synchronous journal transitions before awaits, independent provider guard, no automatic replay, detached outputs and fixed public reason codes.
- [x] Run all device-simulation tests and Main compile. Expected pass/exit0. Commit feat(devices): journal exact simulated approvals and receipts.

### Task 3: real MCP fixture round-trip and final proof
**Files:** Create src/main/device-simulation/mcp-fixture.ts and mcp-fixture.integration.test.ts; docs/device-connector-simulation.md; QA docs/qa/2026-10-18-device-connector-simulation.md. Do not edit mcp-adapter.ts, mcp-manager.ts, normal application or generic policy.
**Interfaces:**
- openFixtureMcp(simulation:DeviceSimulation, session:SimulationSession):Promise<FixtureMcpConnection>
- FixtureMcpConnection returns simulation:true and readonly serverId/url/messageUrl/toolIds, port:McpDevicePort and close():Promise<void>; only owned loopback URL is produced, never accepted.
- Four fixed SDK tools call controller.handleMcp; connectMcpServer config has only generated id/name/sse URL and local exact effect overrides.

- [x] Write real SDK server/client-host integration tests (Electron/RAG environment dependency mocked only; SDK/HTTP/adapter/registry remain real): discovery, all three fixtures read/preview, confirmed command, direct execute rejected, deferred receipt reconciliation, revoked read, HTTP Host/Origin/body/session rejection, cleanup/no persistent mcp-servers.json. Assert scope checks survive allow_all and claimed hints.
- [x] Run filter device-simulation/mcp-fixture. Expected RED before wrapper exists.
- [x] Implement the loopback-only wrapper, body cap, exact routes/session, startup-failure cleanup and shutdown. No candidate subprocess/installer, model call or live endpoint.
- [x] Run device-simulation plus MCP/permissions/storage related regressions. Expected pass; compile Main and run unchanged storage boundary check.
- [x] Document how the test/smoke harness explicitly uses the module, exact simulated limits and abrupt-crash lease limitation. Commit feat(devices): exercise owned fixtures through existing MCP.
- [x] Produce one fresh review package for the whole device branch and send one gpt-6.1-sol/max reviewer (skill-required delegation) the spec, plan, Review Focus and ledger rulings. Fix Critical/Important once using RED->GREEN and related regression; ledger minor deferrals. Never rerun a passing check without a new change/failure.
- [x] Run required full suite once at clean code; no code changes while it runs. Record exact counts, archives, skips and build results.
- [x] Save QA, immutable local handoff/commit mapping and evidence hashes; preserve original batch/tail/integration refs. Remove only this plan's owned scratch after copying ledger/review, then final report with actual scope and limitations. No push/PR/merge.

## Preflight self-review
Contracts flow Task1->2->3 with no unresolved names. Receipt schemas/digests own cross-boundary validation, controller owns permissions and persistence timing, wrapper owns transport/cleanup. Every spec requirement and Review Focus has a named test owner. The normal app remains unchanged; this first simulation batch is not a live connector release.

