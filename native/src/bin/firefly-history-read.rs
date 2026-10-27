//! Private, dormant history-read protocol. No production spawn/actor authorization.
use firefly_screenshot::history_read::{
    AuthorizedHistoryRoot, FileIdentity, HistorySnapshotLease, MAX_SNAPSHOT_BYTES,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};
const VERSION: u8 = 1;
/// Session mode speaks version 2: many sequential read/release cycles in one process.
const SESSION_VERSION: u8 = 2;
const MAX_INPUT: usize = 16 * 1024;
const MAX_OUTPUT: usize = 2 * MAX_SNAPSHOT_BYTES + 1024;
const ACTIVE: u8 = 0;
const COMMITTED: u8 = 1;
const CANCELLED: u8 = 2;

#[derive(Deserialize, Debug)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Read {
        version: u8,
        components: Vec<String>,
        max_bytes: usize,
    },
    Release {
        version: u8,
    },
    Cancel {
        version: u8,
    },
}
impl Command {
    fn version(&self) -> u8 {
        match self {
            Self::Read { version, .. } | Self::Release { version } | Self::Cancel { version } => {
                *version
            }
        }
    }
}
#[derive(Deserialize, Debug)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SessionCommand {
    Read {
        version: u8,
        components: Vec<String>,
        max_bytes: usize,
        deadline_ms: u32,
    },
    Release {
        version: u8,
    },
    Cancel {
        version: u8,
    },
    Close {
        version: u8,
    },
}
impl SessionCommand {
    fn version(&self) -> u8 {
        match self {
            Self::Read { version, .. }
            | Self::Release { version }
            | Self::Cancel { version }
            | Self::Close { version } => *version,
        }
    }
}
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Event<'a> {
    Ready {
        version: u8,
        root_identity: FileIdentity,
    },
    Snapshot {
        version: u8,
        identity: FileIdentity,
        raw_length: usize,
        bytes_hex: String,
    },
    Released {
        version: u8,
    },
    Cancelled {
        version: u8,
    },
    Closed {
        version: u8,
    },
    Error {
        version: u8,
        code: &'a str,
    },
}
enum Mode {
    /// One read, then exit; the whole process ends by `deadline` ms.
    OneShot { deadline: u32 },
    /// Sequential reads until `close`, Main's exit, or `idle` ms without a command.
    Session { idle: u32 },
}
struct Options {
    root: PathBuf,
    parent: u32,
    mode: Mode,
}
fn options() -> Result<Options, &'static str> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 6 {
        return Err("history-invalid-cli");
    }
    let mut root = None;
    let mut parent = None;
    let mut deadline = None;
    let mut idle = None;
    for pair in args.chunks_exact(2) {
        match pair[0].to_str() {
            Some("--root") if root.is_none() => root = Some(PathBuf::from(&pair[1])),
            Some("--parent-pid") if parent.is_none() => {
                parent = pair[1].to_str().and_then(|s| s.parse::<u32>().ok())
            }
            Some("--deadline-ms") if deadline.is_none() && idle.is_none() => {
                deadline = pair[1].to_str().and_then(|s| s.parse::<u32>().ok())
            }
            Some("--idle-ms") if idle.is_none() && deadline.is_none() => {
                idle = pair[1].to_str().and_then(|s| s.parse::<u32>().ok())
            }
            _ => return Err("history-invalid-cli"),
        }
    }
    let (root, parent) = (
        root.ok_or("history-invalid-cli")?,
        parent.ok_or("history-invalid-cli")?,
    );
    let mode = match (deadline, idle) {
        (Some(deadline), None) if (1..=30_000).contains(&deadline) => Mode::OneShot { deadline },
        (None, Some(idle)) if (1..=600_000).contains(&idle) => Mode::Session { idle },
        _ => return Err("history-invalid-cli"),
    };
    if parent == 0 || parent == std::process::id() {
        return Err("history-invalid-cli");
    }
    Ok(Options { root, parent, mode })
}
fn parent_watch(parent: u32, deadline: u32) -> Result<Arc<OwnedHandle>, &'static str> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent) }
        .map_err(|_| "history-parent-unavailable")?;
    let owned = Arc::new(unsafe { OwnedHandle::from_raw_handle(handle.0) });
    if unsafe { WaitForSingleObject(HANDLE(owned.as_raw_handle()), 0) } != WAIT_TIMEOUT {
        return Err("history-parent-unavailable");
    }
    let watch = Arc::clone(&owned);
    // Independent process termination is deliberate: blocked stdout/partial stdin
    // or an OS read cannot keep this lease alive. OS teardown closes all handles.
    thread::spawn(move || {
        let result = unsafe { WaitForSingleObject(HANDLE(watch.as_raw_handle()), deadline) };
        std::process::exit(if result == WAIT_OBJECT_0 {
            74
        } else if result == WAIT_TIMEOUT {
            75
        } else {
            76
        });
    });
    Ok(owned)
}
fn cancel_before_commit(state: &AtomicU8) {
    let _ = state.compare_exchange(ACTIVE, CANCELLED, Ordering::AcqRel, Ordering::Acquire);
}
/// One newline-terminated command line; `None` at a clean end of input.
fn read_line(stream: &mut impl Read) -> Result<Option<Vec<u8>>, &'static str> {
    let mut line = Vec::with_capacity(256);
    loop {
        let mut byte = [0u8; 1];
        match stream.read(&mut byte) {
            Ok(0) if line.is_empty() => return Ok(None),
            Ok(0) => return Err("history-incomplete-command"),
            Ok(_) if byte[0] == b'\n' => return Ok(Some(line)),
            Ok(_) => {
                line.push(byte[0]);
                if line.len() > MAX_INPUT {
                    return Err("history-command-too-large");
                }
            }
            Err(_) => return Err("history-input-failed"),
        }
    }
}
fn input(sender: SyncSender<Result<Option<Command>, &'static str>>, state: Arc<AtomicU8>) {
    let mut stream = io::stdin().lock();
    loop {
        let result = read_line(&mut stream).and_then(|line| match line {
            None => Ok(None),
            Some(line) => match serde_json::from_slice::<Command>(&line) {
                Ok(command) if command.version() == VERSION => Ok(Some(command)),
                _ => Err("history-invalid-command"),
            },
        });
        if !matches!(
            &result,
            Ok(Some(Command::Read { .. } | Command::Release { .. }))
        ) {
            cancel_before_commit(&state);
        }
        let done = matches!(
            &result,
            Err(_) | Ok(None) | Ok(Some(Command::Cancel { .. }))
        );
        if sender.send(result).is_err() || done {
            return;
        }
    }
}
fn encoded(event: &Event<'_>) -> Result<Vec<u8>, &'static str> {
    let mut bytes = serde_json::to_vec(event).map_err(|_| "history-output-failed")?;
    if bytes.len() > MAX_OUTPUT {
        return Err("history-output-too-large");
    }
    bytes.push(b'\n');
    Ok(bytes)
}
fn emit(event: &Event<'_>) -> Result<(), &'static str> {
    let bytes = encoded(event)?;
    let mut output = io::stdout().lock();
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .map_err(|_| "history-output-failed")
}
fn snapshot_event(lease: &HistorySnapshotLease, version: u8) -> Event<'static> {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut bytes_hex = String::with_capacity(lease.bytes().len() * 2);
    for b in lease.bytes() {
        bytes_hex.push(HEX[(b >> 4) as usize] as char);
        bytes_hex.push(HEX[(b & 15) as usize] as char);
    }
    Event::Snapshot {
        version,
        identity: lease.identity(),
        raw_length: lease.bytes().len(),
        bytes_hex,
    }
}
// This fixed-marker barrier is compiled out of release builds. It holds no
// caller-supplied paths and the independent process watchdog remains active.
#[cfg(debug_assertions)]
fn debug_cancel_barrier(state: &AtomicU8, marker: &str) {
    let mut output = io::stderr().lock();
    let _ = writeln!(output, "{marker}");
    let _ = output.flush();
    drop(output);
    while state.load(Ordering::Acquire) == ACTIVE {
        thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn run() -> Result<(), &'static str> {
    let options = options()?;
    let deadline = match options.mode {
        Mode::OneShot { deadline } => deadline,
        Mode::Session { idle } => return run_session(&options, idle),
    };
    // Watchdog is established before potentially blocking root acquisition.
    let parent = parent_watch(options.parent, deadline)?;
    let root = AuthorizedHistoryRoot::open(&options.root).map_err(|error| error.code())?;
    if unsafe { WaitForSingleObject(HANDLE(parent.as_raw_handle()), 0) } != WAIT_TIMEOUT {
        return Err("history-parent-unavailable");
    }
    let state = Arc::new(AtomicU8::new(ACTIVE));
    let (sender, receiver) = mpsc::sync_channel(2);
    let input_state = Arc::clone(&state);
    thread::spawn(move || input(sender, input_state));
    emit(&Event::Ready {
        version: VERSION,
        root_identity: root.identity(),
    })?;
    let command = receiver.recv().map_err(|_| "history-input-failed")??;
    let (components, max_bytes) = match command {
        None => return Ok(()),
        Some(Command::Cancel { .. }) => return emit(&Event::Cancelled { version: VERSION }),
        Some(Command::Read {
            components,
            max_bytes,
            ..
        }) => (components, max_bytes),
        Some(Command::Release { .. }) => return Err("history-invalid-state"),
    };
    if state.load(Ordering::Acquire) == CANCELLED {
        return emit(&Event::Cancelled { version: VERSION });
    }
    #[cfg(debug_assertions)]
    if std::env::var("FF_HISTORY_TEST_PRECOMMIT_CANCEL").as_deref() == Ok("read") {
        let read_state = Arc::clone(&state);
        firefly_screenshot::history_read::install_debug_read_hook(Box::new(move || {
            debug_cancel_barrier(&read_state, "history-test-read-active");
        }));
    }
    let lease = root
        .open_snapshot(&components, max_bytes)
        .map_err(|error| error.code())?;
    let snapshot = encoded(&snapshot_event(&lease, VERSION))?;
    #[cfg(debug_assertions)]
    if std::env::var("FF_HISTORY_TEST_PRECOMMIT_CANCEL").as_deref() == Ok("1") {
        debug_cancel_barrier(&state, "history-test-precommit");
    }
    // This CAS is the publication commit boundary. A previously observed cancel
    // prevents snapshot output. Cancellation after it cannot recall pipe bytes.
    if state
        .compare_exchange(ACTIVE, COMMITTED, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return emit(&Event::Cancelled { version: VERSION });
    }
    {
        let mut output = io::stdout().lock();
        output
            .write_all(&snapshot)
            .and_then(|_| output.flush())
            .map_err(|_| "history-output-failed")?;
    }
    match receiver.recv().map_err(|_| "history-input-failed")?? {
        Some(Command::Release { .. }) => {
            drop(lease);
            drop(root);
            emit(&Event::Released { version: VERSION })
        }
        Some(Command::Cancel { .. }) => {
            drop(lease);
            drop(root);
            emit(&Event::Cancelled { version: VERSION })
        }
        None => Ok(()),
        Some(Command::Read { .. }) => Err("history-invalid-state"),
    }
}
fn session_input(
    sender: SyncSender<Result<Option<SessionCommand>, &'static str>>,
    state: Arc<AtomicU8>,
) {
    let mut stream = io::stdin().lock();
    loop {
        let result = read_line(&mut stream).and_then(|line| match line {
            None => Ok(None),
            Some(line) => match serde_json::from_slice::<SessionCommand>(&line) {
                Ok(command) if command.version() == SESSION_VERSION => Ok(Some(command)),
                _ => Err("history-invalid-command"),
            },
        });
        // Anything but a new read or a release stops a read still before its commit boundary.
        if !matches!(
            &result,
            Ok(Some(SessionCommand::Read { .. } | SessionCommand::Release { .. }))
        ) {
            cancel_before_commit(&state);
        }
        let done = matches!(
            &result,
            Err(_) | Ok(None) | Ok(Some(SessionCommand::Close { .. }))
        );
        if sender.send(result).is_err() || done {
            return;
        }
    }
}
/// Many one-shot cycles in one process. Every read reopens the root, checks it is the directory the
/// session started on, reads and holds the leaf, and drops every handle on release or cancel, so
/// nothing under the root is held between cycles. A lease kept past its read deadline ends the process.
fn run_session(options: &Options, idle: u32) -> Result<(), &'static str> {
    let parent = parent_watch(options.parent, u32::MAX)?;
    let identity = AuthorizedHistoryRoot::open(&options.root)
        .map_err(|error| error.code())?
        .identity();
    if unsafe { WaitForSingleObject(HANDLE(parent.as_raw_handle()), 0) } != WAIT_TIMEOUT {
        return Err("history-parent-unavailable");
    }
    let state = Arc::new(AtomicU8::new(COMMITTED));
    let (sender, receiver) = mpsc::sync_channel(2);
    let input_state = Arc::clone(&state);
    thread::spawn(move || session_input(sender, input_state));
    emit(&Event::Ready {
        version: SESSION_VERSION,
        root_identity: identity,
    })?;
    let idle = Duration::from_millis(u64::from(idle));
    loop {
        let command = match receiver.recv_timeout(idle) {
            Ok(command) => command?,
            Err(RecvTimeoutError::Timeout) => return Ok(()),
            Err(RecvTimeoutError::Disconnected) => return Err("history-input-failed"),
        };
        let (components, max_bytes, deadline_ms) = match command {
            None => return Ok(()),
            Some(SessionCommand::Close { .. }) => {
                return emit(&Event::Closed {
                    version: SESSION_VERSION,
                });
            }
            Some(SessionCommand::Read {
                components,
                max_bytes,
                deadline_ms,
                ..
            }) => (components, max_bytes, deadline_ms),
            Some(SessionCommand::Release { .. } | SessionCommand::Cancel { .. }) => {
                return Err("history-invalid-state");
            }
        };
        if !(1..=30_000).contains(&deadline_ms) {
            return Err("history-invalid-budget");
        }
        let deadline = Instant::now() + Duration::from_millis(u64::from(deadline_ms));
        state.store(ACTIVE, Ordering::Release);
        let root = AuthorizedHistoryRoot::open(&options.root).map_err(|error| error.code())?;
        if root.identity() != identity {
            return Err("history-source-changed");
        }
        let lease = root
            .open_snapshot(&components, max_bytes)
            .map_err(|error| error.code())?;
        let snapshot = encoded(&snapshot_event(&lease, SESSION_VERSION))?;
        if state
            .compare_exchange(ACTIVE, COMMITTED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            // The command that stopped this read is still queued: acknowledge a cancel, or end on close.
            drop(lease);
            drop(root);
            match receiver.recv().map_err(|_| "history-input-failed")?? {
                Some(SessionCommand::Cancel { .. }) => {
                    emit(&Event::Cancelled {
                        version: SESSION_VERSION,
                    })?;
                    continue;
                }
                Some(SessionCommand::Close { .. }) => {
                    return emit(&Event::Closed {
                        version: SESSION_VERSION,
                    });
                }
                None => return Ok(()),
                Some(_) => return Err("history-invalid-state"),
            }
        }
        {
            let mut output = io::stdout().lock();
            output
                .write_all(&snapshot)
                .and_then(|_| output.flush())
                .map_err(|_| "history-output-failed")?;
        }
        let wait = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(wait) {
            Ok(command) => match command? {
                Some(SessionCommand::Release { .. }) => {
                    drop(lease);
                    drop(root);
                    emit(&Event::Released {
                        version: SESSION_VERSION,
                    })?;
                }
                Some(SessionCommand::Cancel { .. }) => {
                    drop(lease);
                    drop(root);
                    emit(&Event::Cancelled {
                        version: SESSION_VERSION,
                    })?;
                }
                None => return Ok(()),
                Some(_) => return Err("history-invalid-state"),
            },
            // Like the one-shot watchdog: exiting is what releases a lease Main never released.
            Err(RecvTimeoutError::Timeout) => std::process::exit(75),
            Err(RecvTimeoutError::Disconnected) => return Err("history-input-failed"),
        }
    }
}
fn main() {
    if let Err(code) = run() {
        let _ = emit(&Event::Error {
            version: VERSION,
            code,
        });
        eprintln!("{code}");
        std::process::exit(78);
    }
    // Exit closes any blocked reader thread; no caller waits for stdin after release.
    std::process::exit(0);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_commit_suppresses_snapshot() {
        let state = AtomicU8::new(ACTIVE);
        cancel_before_commit(&state);
        assert!(
            state
                .compare_exchange(ACTIVE, COMMITTED, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        );
    }
    #[test]
    fn cancellation_after_commit_cannot_recall_bytes() {
        let state = AtomicU8::new(ACTIVE);
        assert!(
            state
                .compare_exchange(ACTIVE, COMMITTED, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        );
        cancel_before_commit(&state);
        assert_eq!(state.load(Ordering::Acquire), COMMITTED);
    }
    #[test]
    fn protocol_rejects_extra_fields_and_wrong_commands() {
        for line in [
            r#"{"type":"cancel","version":1,"actor":"foreign"}"#,
            r#"{"type":"repair","version":1}"#,
            r#"{"type":"read","version":1,"components":[],"maxBytes":1,"maxBytes":2}"#,
        ] {
            assert!(serde_json::from_str::<Command>(line).is_err());
        }
    }
}
