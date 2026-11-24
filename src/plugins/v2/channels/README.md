# Plugin channel host (C12)

`createPluginChannelService` implements host-side `channels.register`,
`channels.reportState` and `channels.deliver` from the shared protocol. A channel
must be declared in the installed, host-resolved manifest. Incoming payloads
cannot select a mode, tool set, runner, permission grant or approval response.

## Composition contract

The application must inject an explicitly trusted `runner.run`, `tools`,
`approveLocally`, `recordSend` and `recordRun`. There is no default runner or approval grant.
`approveLocally` must use the Firefly local approval UI and honor cancellation;
it must never use an external-platform reply to resolve a pending approval.
`recordSend` must persist or display delivery outcomes, including `unknown`.
Recorder failures cannot turn an issued send into a retryable incoming delivery.

Construct the service, call `bindHost(host, resolveInstalledManifest)`, and compose
the returned `configureRpc` with existing service registrations. Return a combined
disposer that calls each service's disposer. The channel binding additionally
observes host status, and registers an independent `onBeforeStop` subscription;
it does not replace C10's lifecycle disposer. Call `bindings.dispose()` when
disposing the application composition. The ordinary plugin stop path must run
before disposing bindings if `channel.stop` needs to reach the live plugin.

The binding starts registered channels when the host becomes `enabled`, handles
late registration while enabled, stops over the live RPC before `deactivate`,
disconnects and cancels sessions before awaiting stop, and unbinds handlers on
crashes. The stale disposer returned by an earlier activation cannot remove the
new activation. An inactive channel can register again after reactivation.

## Runner policy

Each private/group/thread conversation has a separate host-generated identity.
Chat is the default and has an empty tool catalogue and denied dispatcher.
The host-only `setConversationMode` enables Work for one identity. Work admits
only nonempty risk sets consisting entirely of `fs-read`; other tools are both
absent from the catalogue and denied by the dispatcher. The dispatcher rechecks
the current local mode and live tool risks. Mode changes cancel in-flight runs.
Neither mode admits shell, writes, network or input-control tools. There is no
external API for changing mode or approving requests.

The trusted runner must use the supplied catalogue and `dispatchTool` rather than
constructing another dispatcher or restoring tools via a global registry. It must
install `system` as a trusted prompt policy and `content` as the message data.
All external body text is escaped inside the shared `<external-data>` envelope;
the shared untrusted-data policy accompanies every request. Tool results and
approval requests are guarded across cancellation and disposal. Capabilities
expire when a delivery finishes. Injected executors must honor AbortSignal to
stop physical work; a late result cannot cause a reply or a fresh tool dispatch.

Inbound text is limited to 64,000 characters. Attachments are limited to eight,
with a combined data size of 10 MiB. Only declared protocol kinds and bounded
name/MIME strings pass. `url` attachments are rejected because the host cannot
verify remote byte size without fetching them. Bounded `Uint8Array` data is
copied into `untrustedAttachments`; the runner is responsible for safe decoding
and rendering, never treating contents or names as instructions or local paths.
No URL fetching, file write or attachment extraction is performed here.

Replies go through `channel.send`. A plugin process crash during the request is
`unknown`, with no replay after restart. Ordinary RPC failure remains a failure;
only `tool.execute` and `channel.send` use crash uncertainty. The `recordSend`
callback observes automatic replies as well as explicit host sends.
`channels.deliver`'s `accepted` flag means the host accepted the incoming message;
it does not claim external delivery of its reply.

Admission returns immediately after validation. Each conversation has a FIFO
queue bounded at 20 admitted messages, including the active one; overflow is
`ERR_RATE_LIMITED`. A message runs only after the preceding reply send settles.
Background work is independent of the admission RPC signal after acceptance;
disable, mode changes and plugin stop still cancel active and queued messages.
`recordRun` records background failures locally without sending an error reply.
`whenIdle()` waits for currently admitted queues, for bounded tests or shutdown.
Work selections are memory-only; a process restart defaults every chat to Chat.
Persistence belongs to the future channel-settings UI.

## Existing channels and verification boundary

`src/main/features/channels` remains the existing QQ/Feishu channel path. C12 adds
an independent v2 plugin service and composition contract, without migrating old
channel settings, replacing existing adapters, adding settings UI or wiring an
application runner. G39/application integration must supply the trusted adapters
above and route v2 plugin channels separately from existing channel accounts.

Tests exercise the SDK `createPluginContextProxy` over real in-memory RPC, host
lifecycle hooks, declaration validation, Chat/Work policy, external markers,
caps, cancellation, reactivation and crash uncertainty. They do not establish
external-platform connectivity, real local approval UI behavior, durable send
audits or actual attachment decoding.

Validation: `pnpm test src/plugins/v2/channels src/plugins/v2/host src/plugins/v2/services`.
Build main first for the existing real Electron utilityProcess test:
`pnpm run build:main`.
