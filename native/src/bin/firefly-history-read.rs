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
        mpsc::{self, SyncSender},
    },
    thread,
};
use windows::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};
const VERSION: u8 = 1;
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
    Error {
        version: u8,
        code: &'a str,
    },
}
struct Options {
    root: PathBuf,
    parent: u32,
    deadline: u32,
}
fn options() -> Result<Options, &'static str> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 6 {
        return Err("history-invalid-cli");
    }
    let mut root = None;
    let mut parent = None;
    let mut deadline = None;
    for pair in args.chunks_exact(2) {
        match pair[0].to_str() {
            Some("--root") if root.is_none() => root = Some(PathBuf::from(&pair[1])),
            Some("--parent-pid") if parent.is_none() => {
                parent = pair[1].to_str().and_then(|s| s.parse::<u32>().ok())
            }
            Some("--deadline-ms") if deadline.is_none() => {
                deadline = pair[1].to_str().and_then(|s| s.parse::<u32>().ok())
            }
            _ => return Err("history-invalid-cli"),
        }
    }
    let (root, parent, deadline) = (
        root.ok_or("history-invalid-cli")?,
        parent.ok_or("history-invalid-cli")?,
        deadline.ok_or("history-invalid-cli")?,
    );
    if parent == 0 || parent == std::process::id() || !(1..=30_000).contains(&deadline) {
        return Err("history-invalid-cli");
    }
    Ok(Options {
        root,
        parent,
        deadline,
    })
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
fn input(sender: SyncSender<Result<Option<Command>, &'static str>>, state: Arc<AtomicU8>) {
    let mut stream = io::stdin().lock();
    loop {
        let mut line = Vec::with_capacity(256);
        let result = loop {
            let mut byte = [0u8; 1];
            match stream.read(&mut byte) {
                Ok(0) if line.is_empty() => break Ok(None),
                Ok(0) => break Err("history-incomplete-command"),
                Ok(_) if byte[0] == b'\n' => {
                    let parsed: Result<Command, _> = serde_json::from_slice(&line);
                    break match parsed {
                        Ok(command) if command.version() == VERSION => Ok(Some(command)),
                        _ => Err("history-invalid-command"),
                    };
                }
                Ok(_) => {
                    line.push(byte[0]);
                    if line.len() > MAX_INPUT {
                        break Err("history-command-too-large");
                    }
                }
                Err(_) => break Err("history-input-failed"),
            }
        };
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
fn snapshot_event(lease: &HistorySnapshotLease) -> Event<'static> {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut bytes_hex = String::with_capacity(lease.bytes().len() * 2);
    for b in lease.bytes() {
        bytes_hex.push(HEX[(b >> 4) as usize] as char);
        bytes_hex.push(HEX[(b & 15) as usize] as char);
    }
    Event::Snapshot {
        version: VERSION,
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
    // Watchdog is established before potentially blocking root acquisition.
    let parent = parent_watch(options.parent, options.deadline)?;
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
    let snapshot = encoded(&snapshot_event(&lease))?;
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
