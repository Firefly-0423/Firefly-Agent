# Resident history read helper

Status: approved direction by the owner 2026-10-27 ("常驻小程序"). Baseline: docs/readme-showcase.

## Problem

A real Work run in the demo profile spawned `firefly-history-read.exe` about 400 times per round (two at a time, 40–170 ms each). Every native history gate acquires fresh endpoints, and an endpoint is a whole process: open the root, read one leaf and hold it, wait for release, exit. Process creation is about 3–7 s of every round and most of the remaining local wait before each model request.

## What must not change

- Every read re-proves the current files on disk: it opens the root again, checks the root identity, opens the leaf by handle, reads it and holds it until release. A cached result never stands in for a read.
- A lease holds its handles (root, ancestors and leaf, shared read only) until Main releases or cancels it, and Main sees `released`/`cancelled` only after the handles are dropped.
- Cancellation before the commit boundary suppresses the snapshot; after it, the bytes are published.
- A helper cannot outlive Main, and a stuck lease cannot be held indefinitely.
- The `NativeHistoryEndpointFactory` interface and everything above it (`native-history-provider`) are unchanged.

## Design

### Helper: `--session` mode (protocol version 2)

`firefly-history-read.exe --root <dir> --parent-pid <pid> --session --idle-ms <n>` serves many sequential cycles in one process:

1. On start it opens the root once and emits `ready {rootIdentity}`.
2. It waits for a command, for at most `idle-ms`, otherwise exits 0:
   - `read {components, maxBytes, deadlineMs}`:
     - Reopen the root. A root identity that differs from the ready one is `history-source-changed` and ends the session.
     - Open and read the leaf exactly as the one-shot mode does (same commit boundary and cancel rules) and emit `snapshot`.
     - Then wait for `release` or `cancel` for at most `deadlineMs` from the read. If that passes, the process exits, which drops every handle.
     - An independent watchdog thread is armed from before the root is reopened until the lease is dropped (and for 30 s during startup). It exits with 75 at the deadline even while the open, the read or the output is blocked.
   - `release`/`cancel`: drop the lease and the reopened root, then emit `released`/`cancelled`.
   - `close`: emit `closed` and exit 0.
   - Anything else: `history-invalid-state`, and exit.
3. Between cycles the process holds no handle under the root.
4. The parent watch stays, with no fixed process deadline: the session exits when Main exits.

The one-shot mode (no `--session`) stays exactly as is, so existing tests and any older caller keep working.

### Main: a small session pool

`createNativeHistorySessionPool({spawn, size: 4, idleMs: 20000})` implements `NativeHistoryEndpointFactory`:

- `acquire` takes an idle session for the same root, or spawns one. It never waits for capacity: a history read holds its transcript lease while it asks for the snapshot, so queueing could deadlock overlapping reads. Helpers beyond `size` end when released.
- The endpoint's `rootIdentity` is the session's ready identity, and `read` sends `read` with the remaining deadline.
- `dispose('release'|'cancel')` sends the command and resolves on the acknowledgement. The session then returns to the pool.
- Any protocol error, timeout, unexpected exit or abort kills that session. Its `dispose` then waits for the process to close, as the one-shot endpoint does today, so the store barrier still waits for the OS to drop the handles.
- When the provider or backend closes, the pool sends `close` to idle sessions and kills busy ones.

`production-memory-backend` builds the pool instead of the one-shot factory. `NATIVE_CODES` gains no new codes.

## Tests

Rust:
- A session serves three reads in a row, each from current bytes: change the file between reads and see the new bytes.
- A root swapped between reads ends the session with `history-source-changed`.
- No handle is held after `released`: rename the root after release and the rename succeeds.
- Idle timeout and lease deadline exits, including a read blocked on output.
- Session-mode commands with extra fields are rejected.

TS (with a fake child):
- Sessions are reused.
- Four reads that each hold one lease and ask for a second all finish; the extra helpers end on release.
- A protocol error kills a session and the next acquire spawns a fresh one.
- `dispose` after a kill waits for close.
- Cancel before the snapshot.
- Pool close.

Real-run acceptance: helper spawns per round drop from about 400 to at most 4, and the before-request wait shrinks accordingly.

## Rollback

`production-memory-backend` switches back to the one-shot factory with a single line. The helper's one-shot mode is untouched.
