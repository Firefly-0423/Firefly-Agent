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
are scoped to both revisions. Successful confirmations are stored through the
required `confirmations` adapter using the grant revision only. A completed
confirmation survives a change of conversation or a restart. The adapter must
persist grant revisions and never reuse one after revocation, regrant or upgrade.

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

Events span conversations and exclude other plugins' private records using
trusted owner metadata. DTOs omit paths and bodies. The event queue holds at
most 100 records and drops the oldest on overflow. Cancellation releases the
subscription. Losing the events grant clears pending records and ends the
stream with `ERR_PERMISSION`.

Validation: `pnpm exec vitest run src/plugins/v2/services src/plugins/v2/host/index.test.ts`.
