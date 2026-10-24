//! Dormant private metadata-only helper. Parent PID is liveness, not authorization.
use firefly_screenshot::history_read::{AuthorizedHistoryRoot, SnapshotPresence};
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
const MAX_INPUT: usize = 32 * 1024;
const MAX_OUTPUT: usize = 8 * 1024;
const ACTIVE: u8 = 0;
const PUBLISHING: u8 = 1;
const CANCELLED: u8 = 2;
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Probe {
        version: u8,
        session_ids: Vec<String>,
    },
    Cancel {
        version: u8,
    },
}
impl Command {
    fn valid(&self) -> bool {
        match self {
            Self::Probe {
                version,
                session_ids,
            } => *version == VERSION && !session_ids.is_empty() && session_ids.len() <= 32,
            Self::Cancel { version } => *version == VERSION,
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
    },
    Results {
        version: u8,
        observations: &'a [SnapshotPresence],
    },
    Cancelled {
        version: u8,
    },
    Error {
        version: u8,
        code: &'static str,
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
        return Err("presence-invalid-cli");
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
            _ => return Err("presence-invalid-cli"),
        }
    }
    let result = Options {
        root: root.ok_or("presence-invalid-cli")?,
        parent: parent.ok_or("presence-invalid-cli")?,
        deadline: deadline.ok_or("presence-invalid-cli")?,
    };
    if result.parent == 0
        || result.parent == std::process::id()
        || !(1..=30000).contains(&result.deadline)
    {
        return Err("presence-invalid-cli");
    }
    Ok(result)
}
fn watch(parent: u32, deadline: u32) -> Result<Arc<OwnedHandle>, &'static str> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent) }
        .map_err(|_| "presence-parent-unavailable")?;
    let owned = Arc::new(unsafe { OwnedHandle::from_raw_handle(handle.0) });
    if unsafe { WaitForSingleObject(HANDLE(owned.as_raw_handle()), 0) } != WAIT_TIMEOUT {
        return Err("presence-parent-unavailable");
    }
    let handle = Arc::clone(&owned);
    thread::spawn(move || {
        let status = unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), deadline) };
        std::process::exit(if status == WAIT_OBJECT_0 {
            74
        } else if status == WAIT_TIMEOUT {
            75
        } else {
            76
        });
    });
    Ok(owned)
}
fn read_command(reader: &mut impl Read) -> Result<Option<Command>, &'static str> {
    let mut line = Vec::with_capacity(256);
    loop {
        let mut byte = [0];
        match reader.read(&mut byte) {
            Ok(0) if line.is_empty() => return Ok(None),
            Ok(0) => return Err("presence-incomplete-command"),
            Ok(_) if byte[0] == b'\n' => {
                let command: Command =
                    serde_json::from_slice(&line).map_err(|_| "presence-invalid-command")?;
                return if command.valid() {
                    Ok(Some(command))
                } else {
                    Err("presence-invalid-command")
                };
            }
            Ok(_) => {
                line.push(byte[0]);
                if line.len() > MAX_INPUT {
                    return Err("presence-command-too-large");
                }
            }
            Err(_) => return Err("presence-input-failed"),
        }
    }
}
fn input(sender: SyncSender<Result<Option<Command>, &'static str>>, state: Arc<AtomicU8>) {
    let mut stdin = io::stdin().lock();
    loop {
        let result = read_command(&mut stdin);
        if matches!(&result, Err(_) | Ok(Some(Command::Cancel { .. }))) {
            state.store(CANCELLED, Ordering::Release);
        }
        let done = !matches!(&result, Ok(Some(Command::Probe { .. })));
        if sender.send(result).is_err() || done {
            return;
        }
    }
}
fn emit(event: &Event<'_>) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(event).map_err(|_| "presence-output-failed")?;
    if bytes.len() > MAX_OUTPUT {
        return Err("presence-output-too-large");
    }
    bytes.push(b'\n');
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|_| stdout.flush())
        .map_err(|_| "presence-output-failed")
}
fn run() -> Result<(), &'static str> {
    let options = options()?;
    // One watchdog spans root acquisition, every batch and blocked pipes.
    let _parent = watch(options.parent, options.deadline)?;
    let root = AuthorizedHistoryRoot::open(&options.root).map_err(|e| e.code())?;
    let state = Arc::new(AtomicU8::new(ACTIVE));
    let (sender, receiver) = mpsc::sync_channel(1);
    let input_state = Arc::clone(&state);
    thread::spawn(move || input(sender, input_state));
    emit(&Event::Ready { version: VERSION })?;
    let mut total = 0;
    loop {
        let command = receiver.recv().map_err(|_| "presence-input-failed")??;
        let ids = match command {
            None => return Ok(()),
            Some(Command::Cancel { .. }) => return emit(&Event::Cancelled { version: VERSION }),
            Some(Command::Probe { session_ids, .. }) => session_ids,
        };
        total += ids.len();
        if total > 10000 {
            return Err("presence-budget-exhausted");
        }
        let mut observations = Vec::with_capacity(ids.len());
        for id in &ids {
            if state.load(Ordering::Acquire) == CANCELLED {
                return emit(&Event::Cancelled { version: VERSION });
            }
            // Aliased IDs cannot create two observations of the same case-insensitive path.
            if ids
                .iter()
                .filter(|other| other.to_uppercase() == id.to_uppercase())
                .count()
                > 1
            {
                observations.push(SnapshotPresence::UnknownDenied {
                    reason: "history-invalid-path",
                });
            } else {
                observations.push(root.probe_snapshot_presence(id));
            }
        }
        // Cancellation observed before this publication boundary suppresses the batch.
        if state
            .compare_exchange(ACTIVE, PUBLISHING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return emit(&Event::Cancelled { version: VERSION });
        }
        emit(&Event::Results {
            version: VERSION,
            observations: &observations,
        })?;
        let _ = state.compare_exchange(PUBLISHING, ACTIVE, Ordering::AcqRel, Ordering::Acquire);
    }
}
fn main() {
    if let Err(code) = run() {
        let _ = emit(&Event::Error {
            version: VERSION,
            code,
        });
        std::process::exit(78);
    }
    std::process::exit(0);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_protocol_rejects_body_paths_wrong_version_and_large_batches() {
        for line in [
            r#"{"type":"read","version":1,"components":["a"]}"#,
            r#"{"type":"probe","version":1,"sessionIds":["a"],"root":"foreign"}"#,
            r#"{"type":"probe","version":1,"sessionIds":["a"],"sessionIds":["b"]}"#,
            r#"{"type":"probe","version":2,"sessionIds":["a"]}"#,
            r#"{"type":"probe","version":1,"sessionIds":[]}"#,
        ] {
            let input = format!("{line}\n");
            assert!(read_command(&mut input.as_bytes()).is_err());
        }
        let large = serde_json::json!({"type":"probe", "version":1, "sessionIds": vec!["a";33]})
            .to_string()
            + "\n";
        assert!(read_command(&mut large.as_bytes()).is_err());
        assert!(read_command(&mut vec![b'x'; MAX_INPUT + 1].as_slice()).is_err());
    }
    #[test]
    fn early_cancel_cannot_publish_results() {
        let state = AtomicU8::new(ACTIVE);
        state.store(CANCELLED, Ordering::Release);
        assert!(
            state
                .compare_exchange(ACTIVE, PUBLISHING, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        );
    }
}
