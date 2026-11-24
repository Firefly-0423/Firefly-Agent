# Plugin host services (1.2.0)

`createPluginHostServices(dependencies).configureRpc` plugs into the v2
`PluginHostManager`'s `configureRpc` hook. The manager owns the returned disposer
and invokes it on stop, crash, or failed activation. Keep one services instance
for the lifetime of the application so restarts do not reset model quota.

All dependencies are required unless marked optional. The application composition
root must provide installed-manifest/user-grant access, current conversation
binding, a separate first-use confirmation UI, the current model profile, normal
run-controller/approval integration, borrowing indication with a stop button,
public transcript projections, actual secret/path redaction (including a separate stateful streaming redactor), workspace change notifications, and scoped event
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
| `model.generate` | `{prompt, system?, maxOutputTokens?, schema?, stream?}` | Plain `{text, usage?}`; `stream: true` emits `{delta}` chunks |
| `model.run` | `{objective, mode, sessionId?, allowPartners?}` | Run event chunks followed by `{type: "run.result", result: {runId, sessionId, reply}}` |
| `events.subscribe` | `{type: EventType}` | `chunk` frames with the four event DTOs from the specification |
| `sessions.list` | `{cursor?, limit?, mode?}` | `{items: [{id, mode, title, updatedAt}], nextCursor}` |
| `sessions.messages` | `{sessionId, cursor?, limit?}` | `{items: [{id, role, content, createdAt}], nextCursor}` |
| `workspace.info` | `{sessionId?}` | `{sessionId, mode, root, name}` |
| `workspace.watch` | `{}` | Binding change chunks with current workspace metadata, or `null` after unbinding |

`model.run` uses source `plugin` and the trusted plugin identity, enters the normal
host run/approval path, and only targets the host's bound conversation. The `run` adapter receives an `onEvent` callback as its fourth argument and must
report protocol run events only. The service projects fields, bounds pending run
events at 100 (overflow fails closed), and sends the final `run.result` chunk only
after all accepted events. The required `generateStream` adapter supplies model
deltas. Every outbound model chunk and terminal result rechecks live access and
the original conversation binding. Global read-only events use `events.subscribe`.

`createStreamRedactor(context)` creates a fresh stateful redactor for each model
stream. Its `push(text)` must retain any undecidable suffix, including credentials
or foreign paths split across provider chunks, and return only safe text. Its
`finish()` releases the sanitized final tail. Never wire an identity function or
chunk-local regex as a production fallback: fail closed if the host cannot supply
this adapter. Pending suffixes are discarded on cancellation, revocation, rebind,
or error. A delayed safe text tail may appear immediately before `run.result`.
The ordinary `redact` adapter remains responsible for complete messages/results.

Protocol parameter/result/chunk maps are authoritative; terminal pages omit `nextCursor`.

Cursors are decimal offsets. Limits are 1–100, default 50. Host session projections
must preserve deterministic order. Sessions are restricted to the bound workspace;
other-plugin records are filtered. Messages must already be public user/assistant
projections with no tool traces, attachments, hidden context or other-plugin
payloads. The service additionally reconstructs exact DTO fields and calls the
mandatory host redactor on text. The host redactor must know real secrets and
foreign paths; this module does not claim regex can detect arbitrary credentials.

`workspace.info` intentionally discloses only the approved current root.
File reads and writes use approved tools. `watchWorkspace(pluginId, listener)`
must notify whenever the host-owned binding changes, including unbinding. Watch
streams survive binding changes, reuse the approved workspace grant revision,
and stop on access loss, revision change, cancellation or disposal. Notifications
are coalesced and each delivery reads the trusted current binding, never a path
supplied by the plugin.

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
