//! Private Main-to-helper protocol. stdin/stdout only; no shell, path-based leaf I/O or test hooks.
use firefly_screenshot::workspace_access::{self, Snapshot, WorkspaceBackend, WorkspaceFile, WorkspaceRoot, WriteMode};
use serde::Deserialize;
use serde_json::json;
use std::{io::{self, BufRead, Read, Write}, path::PathBuf};
#[derive(Debug)]
struct Failure { code: &'static str, reason: workspace_access::ErrorReason }
impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        use workspace_access::ErrorReason;
        Self { code, reason: match code {
            "workspace-budget" => ErrorReason::Budget,
            "workspace-unsupported-platform" => ErrorReason::UnsupportedPlatform,
            "workspace-input" | "workspace-output" | "workspace-parent" => ErrorReason::Io,
            _ => ErrorReason::Protocol,
        } }
    }
}
impl From<workspace_access::WorkspaceError> for Failure {
    fn from(error: workspace_access::WorkspaceError) -> Self {
        use workspace_access::WorkspaceError;
        let code = match error {
            WorkspaceError::SharingViolation => "workspace-busy",
            WorkspaceError::Io => "workspace-io",
            WorkspaceError::Missing => "workspace-missing",
            WorkspaceError::Budget => "workspace-budget",
            WorkspaceError::UnsupportedPlatform => "workspace-unsupported-platform",
            _ => "workspace-boundary",
        };
        Self { code, reason: error.reason() }
    }
}
#[derive(serde::Serialize)]
struct ErrorFrame {
    #[serde(rename = "type")]
    kind: &'static str,
    version: u8,
    code: &'static str,
    reason: workspace_access::ErrorReason,
}
fn error_frame(failure: Failure) -> serde_json::Value {
    serde_json::to_value(ErrorFrame { kind: "error", version: 1, code: failure.code, reason: failure.reason }).expect("fixed error frame")
}
const MAX_FRAME: usize = workspace_access::MAX_BYTES * 2 + 128 * 1024;
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Command {
    Read { version: u8, components: Vec<String>, max_bytes: usize },
    Stat { version: u8, components: Vec<String> },
    List { version: u8, components: Vec<String> },
    PrepareWrite { version: u8, components: Vec<String>, create_parents: bool },
    Commit { version: u8, mode: WriteMode, bytes_hex: String },
    Release { version: u8 },
}
impl Command {
    fn version(&self) -> u8 { match self {
        Self::Read { version, .. } | Self::Stat { version, .. } | Self::List { version, .. } |
        Self::PrepareWrite { version, .. } | Self::Commit { version, .. } | Self::Release { version } => *version,
    } }
}
fn command(reader: &mut impl BufRead) -> Result<Command, &'static str> {
    let mut line = Vec::new();
    reader.take((MAX_FRAME+1) as u64).read_until(b'\n', &mut line).map_err(|_| "workspace-input")?;
    if line.len() > MAX_FRAME || line.last() != Some(&b'\n') { return Err("workspace-protocol"); }
    let command: Command = serde_json::from_slice(&line).map_err(|_| "workspace-protocol")?;
    if command.version() != 1 { return Err("workspace-protocol"); }
    Ok(command)
}
fn emit(event: serde_json::Value) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(&event).map_err(|_| "workspace-output")?;
    if bytes.len() > MAX_FRAME { return Err("workspace-budget"); }
    bytes.push(b'\n');
    io::stdout().lock().write_all(&bytes).and_then(|_| io::stdout().flush()).map_err(|_| "workspace-output")
}
fn snapshot(value: Snapshot) -> Result<(), &'static str> { emit(json!({"type":"snapshot", "version":1, "snapshot":value})) }
#[cfg(windows)]
fn watchdog(parent: u32, deadline: u32) -> Result<(), &'static str> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::Win32::{Foundation::{HANDLE, WAIT_TIMEOUT}, System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject}};
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent) }.map_err(|_| "workspace-parent")?;
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    if unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) } != WAIT_TIMEOUT { return Err("workspace-parent"); }
    std::thread::spawn(move || {
        let _ = unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), deadline) };
        // OS process teardown closes leases even during blocked stdin/stdout or native I/O.
        std::process::exit(75);
    });
    Ok(())
}
#[cfg(not(windows))]
fn watchdog(_: u32, _: u32) -> Result<(), &'static str> { Err("workspace-unsupported-platform") }
fn run() -> Result<(), Failure> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 6 { return Err("workspace-cli".into()); }
    let mut root = None; let mut parent = None; let mut deadline = None;
    for pair in args.chunks_exact(2) {
        match pair[0].to_str() {
            Some("--root") if root.is_none() => root = Some(PathBuf::from(&pair[1])),
            Some("--parent-pid") if parent.is_none() => parent = pair[1].to_str().and_then(|s| s.parse::<u32>().ok()),
            Some("--deadline-ms") if deadline.is_none() => deadline = pair[1].to_str().and_then(|s| s.parse::<u32>().ok()),
            _ => return Err("workspace-cli".into()),
        }
    }
    let parent = parent.ok_or("workspace-cli")?;
    let deadline = deadline.ok_or("workspace-cli")?;
    if parent == 0 || parent == std::process::id() || !(1..=30000).contains(&deadline) { return Err("workspace-cli".into()); }
    watchdog(parent, deadline)?;
    let root = WorkspaceRoot::open(&root.ok_or("workspace-cli")?)?;
    emit(json!({"type":"ready", "version":1}))?;
    let mut reader = io::stdin().lock();
    let mut lease = match command(&mut reader)? {
        Command::Read { components, max_bytes, .. } => { snapshot(root.read(&components, max_bytes)?)?; None },
        Command::Stat { components, .. } => { snapshot(root.stat(&components)?)?; None },
        Command::List { components, .. } => { emit(json!({"type":"entries", "version":1, "entries":root.list(&components)?}))?; None },
        Command::PrepareWrite { components, create_parents, .. } => {
            let lease = root.prepare_write(&components, create_parents)?;
            snapshot(lease.before().clone())?; Some(lease)
        },
        _ => return Err("workspace-protocol".into()),
    };
    let next = command(&mut reader)?;
    let next = match next {
        Command::Commit { mode, bytes_hex, .. } => {
            let bytes = workspace_access::decode_hex(&bytes_hex).map_err(|_| "workspace-protocol")?;
            let file = lease.as_mut().ok_or("workspace-protocol")?;
            snapshot(file.commit(mode, &bytes)?)?;
            command(&mut reader)?
        },
        other => other,
    };
    if !matches!(next, Command::Release { .. }) { return Err("workspace-protocol".into()); }
    drop(lease); drop(root);
    emit(json!({"type":"released", "version":1})).map_err(Into::into)
}
fn main() {
    if let Err(failure) = run() {
        let _ = emit(error_frame(failure));
        std::process::exit(78);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_have_exact_typed_frames() {
        use workspace_access::WorkspaceError;
        for (error, code, reason) in [
            (WorkspaceError::ReparsePoint, "workspace-boundary", "reparse-point"),
            (WorkspaceError::HardLink, "workspace-boundary", "hard-link"),
            (WorkspaceError::Boundary, "workspace-boundary", "outside-root"),
            (WorkspaceError::SharingViolation, "workspace-busy", "sharing-violation"),
            (WorkspaceError::Missing, "workspace-missing", "missing"),
            (WorkspaceError::Io, "workspace-io", "io"),
        ] {
            assert_eq!(error_frame(error.into()), json!({"type":"error", "version":1, "code":code, "reason":reason}));
        }
        assert_eq!(error_frame("workspace-protocol".into()), json!({"type":"error", "version":1, "code":"workspace-protocol", "reason":"protocol"}));
    }
    #[test]
    fn strict_commands_and_version() {
        for bytes in [b"{\"type\":\"release\",\"version\":2}\n".as_slice(),
            b"{\"type\":\"release\",\"version\":1,\"path\":\"outside\"}\n",
            b"{\"type\":\"release\",\"version\":1}",
            b"{\"type\":\"read\",\"version\":1,\"components\":[],\"maxBytes\":1,\"maxBytes\":2}\n"] {
            assert!(command(&mut std::io::Cursor::new(bytes)).is_err());
        }
        assert!(workspace_access::decode_hex("0g").is_err());
        assert!(workspace_access::decode_hex("0").is_err());
        assert_eq!(workspace_access::decode_hex("00ff").unwrap(), [0, 255]);
    }
}
