# Device Connector simulation design

Authority: the parent follow-up explicitly requests the concrete plan after bounded external-skills integration, reuses existing MCP, and permits continuing within the previously approved simulation scope once the plan is ready. This overrides additional skill stage-confirmation gates. Execution is inline with one fresh final review. No real accounts, devices, credentials, external candidate execution, installation/download, new dependencies, packaging, push, PR, target merge or deployment.

## Outcome and boundaries

Build a testable simulation of light, AC and curtain control that proves discovery/state, action preview, exact local confirmation, durable pending commands and receipt validation through the existing MCP host. All public DTOs carry simulation:true. It is an explicit test/smoke-profile module; no application startup, GUI, IPC, generic MCP-manager configuration, vendor endpoint or production integration is added.

The success criterion is a real local MCP protocol round-trip against owned fixtures plus adversarial lifecycle tests, without a paid model or real device. Fixture success establishes only this simulated provider's behavior.

## Approaches and chosen seams

A direct fake callback is sufficient for unit fault injection but cannot prove the host's SDK/registry path. A new generic MCP transport would alter the existing host and duplicate integration work. Choose an owned 127.0.0.1 ephemeral SSE fixture using the already installed @modelcontextprotocol/sdk 1.31.0 and connectMcpServer/disconnectMcpServer. SSE is a compatibility transport supported by the current host; its SDK API is deprecated, so this bounded simulator does not make it a new general transport recommendation.

Keep fixture/state/authorization in a focused domain controller. The protocol wrapper exposes read, preview, execute(operationId) and receipt(operationId) only. It never exposes grant/confirm/completion methods. The trusted simulation harness creates opaque session objects; owner/scope authority cannot be supplied in MCP arguments, tool annotations or permissionMode=allow_all.

## Exact fixture semantics

- IDs: light, ac, curtain, each with monotonically increasing revision starting at 0.
- Light initial power:false, brightness:50; actions power(on:boolean), brightness(value:integer 0..100).
- AC initial power:false, mode:cool, setpointC:24, roomTemperatureC:26; actions power, mode(value:cool|heat|fan), setpoint(celsius:16..30 in 0.5 increments). Changing setpoint never changes roomTemperatureC.
- Curtain initial position:0; action position(percent:integer 0..100). This fixture explicitly defines 0=closed and 100=open; no real vendor orientation is inferred.
- Reject unknown device/action/keys, wrong primitive types, NaN/Infinity and out-of-range values. Never coerce strings. Snapshots/previews/results are detached copies.

## Authorization and preview

A trusted host opens an opaque session with a bounded synthetic owner ID, device read allowlist and per-device action-type allowlist. Empty grants deny. Revocation takes immediate effect before dispatch/provider application; already accepted commands remain uncertain until receipt verification.

Read and preview never change the fixture or journal. Preview is memory-only, bounded to 32 entries, expires in 30,000 ms and captures owner, current runtime epoch, device, normalized action, before snapshot/revision and SHA256 intent digest. Confirm(session, previewId) revalidates current scope, expiry and revision, consumes the private preview and atomically stores one approved immutable operation. No serialized preview or model-supplied approved:true is trusted.

Dispatch accepts only an owned approved operation in the current epoch, with unexpired exact approval and unchanged revision. It atomically persists dispatching before invoking MCP. The fixture handler independently enforces session scope, owner, exact stored action, current epoch/deadline and dispatching status; a raw MCP execute cannot create an intent or approve it. Execute arguments contain only a nonsecret operation ID; no grants, tokens or credentials enter the existing adapter's argument logs.

## Durable state and receipts

Use the existing AtomicJsonStore under StorageContext.profile.userData/device-simulation/journal.json, only for test/smoke profiles with an isolationRoot. Validate canonical ownership, fixed file names, size <= 1,048,576 bytes, regular files with one link, no symlink/junction escape, and journal shape before every read/write. Keep at most 128 operations; only verified terminal (applied/rejected/cancelled) history may be pruned oldest-first. Never evict unresolved history to accept new work. A trusted host may cancel an approved, unsent intent; sent operations cannot be cancelled into not_applied. Invalid existing JSON/shape is never overwritten.

A profile-local exclusive lease prevents concurrent owners; no automatic stale-lock deletion. Normal disposal/reconstruction is supported. Abrupt process death preserves the journal but leaves the lease fail-closed; offline lease recovery after proving the old owner exited is outside this batch. Do not claim multi-process exactly-once execution or OS-security isolation.

The journal stores the simulated world plus separate provider receipt and host-verified receipt for each exact immutable intent. Applying the fixture effect and recording its provider receipt is one atomic write. A final RPC receipt must agree with this owned fixture's durable provider record; it cannot upgrade accepted into applied. This local cross-check is not vendor cryptographic attestation. Repeating an already applied operation only returns its stored receipt; new IDs require new confirmation.

Receipts are closed-shape, bounded and correlated by providerId, owner, runtime epoch at approval, operationId, intent digest, device/action, before revision and phase. Applied includes the exact expected resulting state/revision; accepted includes the unchanged before state and does not prove application. A deferred fixture completes only through a trusted simulation-harness method, then reconciliation queries receipt through MCP.

Any timeout, disconnect, cancellation after dispatch, malformed/contradictory receipt or lost ownership leaves unknown; retryable:false. No automatic resend, new-ID replay or inverse-action rollback. A missing receipt cannot prove no effect. After reconstruction, dispatching becomes unknown and only explicit read-only receipt reconciliation is permitted; old approvals cannot execute in a new epoch. A matching state alone never proves that a particular operation caused it.

Verified terminal status is monotonic: a late accepted acknowledgement must not replace an already verified applied/rejected/cancelled record. A read-only readiness checkpoint validates journal health and lease ownership before any reconciliation query, fixture listener/connection creation or fixture MCP handling; it does not reload disk data into cached domain state.

## Local protocol boundary

The wrapper owns one ephemeral loopback listener and one MCP session; no arbitrary URL, command, env, auth or credentials input. Reject unexpected Host, Origin, route, method/session and JSON bodies over 16 KiB. Tool definitions are fixed, server handlers validate exact arguments, and only locally configured effectKindOverrides classify read/preview as read, receipt as verification and execute as external_side_effect. Annotations alone never grant rights.

Shutdown removes only its owned registry IDs, closes SDK/HTTP resources, and leaves the journal for inspection. Late responses after controller disposal cannot change a later owner's journal. The generic MCP manager, permissions, transport adapter and normal application bootstrap remain unchanged.

## Verification and deliberate limits

Unit tests exercise fixture ranges, snapshots, profile/path/journal bounds, authority forgery/revocation/owner confusion, stale approvals, persist-before-send failure, duplicate calls, deferred accepted state, lost acknowledgements, wrong receipts, cancellation and reconstruction without resend. A real loopback SDK/host test exercises discovery, state/preview, confirmation/dispatch, receipt reconciliation, direct-MCP rejection, cleanup and no mcp-servers.json write.

No GUI confirmation, real hardware latency/telemetry, OAuth/secret vault, vendor SDK/protocol, scheduler, groups/scenes, automatic retries, remote access or app activation is implemented. Existing generic MCP does not itself establish device authorization or vendor receipt attestation.

Sources verified 2026-10-18: local SDK 1.31.0 server/sse.d.ts, server/index.d.ts and implementation; existing src/main/orchestrator/mcp-adapter.ts, mcp-manager.ts, tools/registry/tool-registry.ts, tool-context.ts, tool-execution-error.ts; runtime-profile.ts, storage-context.ts and atomic-json-store.ts. MCP annotations are untrusted hints: https://modelcontextprotocol.io/specification/2026-07-28/server/tools . Existing-host transport compatibility reference: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports .

