# Plugin host services (1.2.0)

`createPluginHostServices(dependencies).configureRpc` plugs into the v2
`PluginHostManager`'s `configureRpc` hook. The manager owns the returned disposer
and invokes it on stop, crash, or failed activation. Keep one services instance
for the lifetime of the application so restarts do not reset model quota.

All dependencies are required unless marked optional. The application composition
root must provide installed-manifest/user-grant access, current conversation
binding, a separate first-use confirmation UI, the current model profile, normal
run-controller/approval integration, borrowing indication with a stop button,
public transcript projections, actual secret/path redaction, and scoped event
subscription. No service creates grants or treats plugin parameters as authority.
`onAccessChange` must notify synchronously for revoke/regrant, disable, and binding
changes. Increment access revision for grant/manifest/lifecycle changes and context
revision whenever the bound conversation/workspace changes. Pending confirmations
are scoped to both revisions; a changed binding requires new confirmation.

The application lifecycle/UI composition is a subsequent package. The old plugin
host is untouched. These adapters are not permissive production defaults.

## Wire data

Methods use `PLUGIN_TO_HOST_METHODS` from the shared protocol. Inputs are exact
objects; extra keys are rejected. Optional arguments can be `{}`/`undefined`.

| Method | Input | Result |
| --- | --- | --- |
| `model.generate` | `{prompt, system?, maxOutputTokens?, schema?}` | `{text, usage?: {inputTokens, outputTokens}}` |
| `model.run` | `{objective, mode, sessionId?, allowPartners?}` | `{runId, sessionId, reply}` |
| `events.subscribe` | `{types?: EventType[]}` | `chunk` frames with the four event DTOs from the specification |
| `sessions.list` | `{cursor?, limit?, mode?}` | `{items: [{id, mode, title, createdAt, updatedAt}], nextCursor}` |
| `sessions.messages` | `{sessionId, cursor?, limit?}` | `{items: [{id, role, text, at}], nextCursor}` |
| `workspace.info` | `{sessionId?}` | `{sessionId, mode, root, name}` |

`model.run` uses source `plugin` and the trusted plugin identity, enters the normal
host run/approval path, and only targets the host's bound conversation. This RPC
returns the final result; the SDK's per-run events/result facade and
`generateStream` still require coordinated SDK integration. Global read-only
events are available through `events.subscribe`.

Cursors are decimal offsets. Limits are 1–100, default 50. Host session projections
must preserve deterministic order. Sessions are restricted to the bound workspace;
other-plugin records are filtered. Messages must already be public user/assistant
projections with no tool traces, attachments, hidden context or other-plugin
payloads. The service additionally reconstructs exact DTO fields and calls the
mandatory host redactor on text. The host redactor must know real secrets and
foreign paths; this module does not claim regex can detect arbitrary credentials.

`workspace.info` intentionally discloses only the approved current root.
File reads and writes use approved tools.

Model calls share a sliding 60-second quota per plugin (default 10, live callback
setting 1–60). Rejected, cancelled-before-admission and unconfigured calls do not
consume quota. Once admitted to the model, a failed/cancelled call counts because
it may have consumed provider resources. Revocation, context changes, client
cancellation and the borrowing stop button abort outstanding operations. Adapters
must honor the supplied signal to actually stop external effects.

Events require trusted scope metadata (`sessionId` and/or owning `pluginId`, plus
`workspaceRoot` when applicable), remove that metadata before delivery, and drop
foreign records. Queues hold at most 100 records, dropping the oldest on overflow;
consumers never block a run. Cancel/revoke/rebind clears pending event data and
unsubscribes. Tool/schedule source adapters must attach scope metadata since those
public event DTOs alone do not identify a conversation.

Validation: `pnpm exec vitest run src/plugins/v2/services src/plugins/v2/host/index.test.ts`.
