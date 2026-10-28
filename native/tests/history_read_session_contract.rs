#![cfg(all(windows, feature = "history-read"))]
//! The resident (session) mode of firefly-history-read, driven as Main drives it: one process, many
//! read/release cycles, every read proven from the disk again.
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

// Same isolation rule as history_read_contract: an existing E root from FF_HISTORY_TEST_ROOT or TEMP.
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let base = std::env::var_os("FF_HISTORY_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        assert!(
            matches!(base.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(d) if d.eq_ignore_ascii_case(&b'E'))),
            "configure an existing isolated absolute E root via FF_HISTORY_TEST_ROOT or TEMP/TMP"
        );
        let path = base.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(path.join("transcripts").join("session-a")).unwrap();
        Self(path)
    }
    fn root(&self) -> PathBuf {
        self.0.join("transcripts")
    }
    fn write(&self, text: &str) {
        fs::write(self.root().join("session-a").join("snapshot.json"), text).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Session {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Session {
    fn start(root: &PathBuf, idle_ms: u32) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_firefly-history-read"))
            .args(["--root"])
            .arg(root)
            .args([
                "--parent-pid",
                &std::process::id().to_string(),
                "--idle-ms",
                &idle_ms.to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }
    fn event(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or(Value::Null)
    }
    fn read(&mut self) -> Value {
        self.send(json!({"type":"read","version":2,"components":["session-a","snapshot.json"],"maxBytes":4096,"deadlineMs":5000}));
        self.event()
    }
    fn exit_code(&mut self, within: Duration) -> Option<i32> {
        let until = Instant::now() + within;
        while Instant::now() < until {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn text(snapshot: &Value) -> String {
    let hex = snapshot["bytesHex"].as_str().unwrap();
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn one_session_serves_many_reads_and_each_sees_the_current_file() {
    let fixture = Fixture::new();
    fixture.write("first");
    let mut session = Session::start(&fixture.root(), 10_000);
    let ready = session.event();
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["version"], 2);
    for expected in ["first", "second", "third"] {
        fixture.write(expected);
        let snapshot = session.read();
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(text(&snapshot), expected);
        session.send(json!({"type":"release","version":2}));
        assert_eq!(session.event()["type"], "released");
    }
    session.send(json!({"type":"close","version":2}));
    assert_eq!(session.event()["type"], "closed");
    assert_eq!(session.exit_code(Duration::from_secs(5)), Some(0));
}

#[test]
fn nothing_under_the_root_is_held_between_reads() {
    let fixture = Fixture::new();
    fixture.write("held");
    let mut session = Session::start(&fixture.root(), 10_000);
    session.event();
    session.read();
    // While leased, the root cannot be renamed.
    assert!(fs::rename(fixture.root(), fixture.0.join("moved")).is_err());
    session.send(json!({"type":"release","version":2}));
    assert_eq!(session.event()["type"], "released");
    fs::rename(fixture.root(), fixture.0.join("moved")).unwrap();
    fs::rename(fixture.0.join("moved"), fixture.root()).unwrap();
}

#[test]
fn a_root_replaced_between_reads_ends_the_session() {
    let fixture = Fixture::new();
    fixture.write("original");
    let mut session = Session::start(&fixture.root(), 10_000);
    session.event();
    session.read();
    session.send(json!({"type":"release","version":2}));
    session.event();
    fs::rename(fixture.root(), fixture.0.join("old")).unwrap();
    fs::create_dir_all(fixture.root().join("session-a")).unwrap();
    fixture.write("impostor");
    let refused = session.read();
    assert_eq!(refused["type"], "error");
    assert_eq!(refused["code"], "history-source-changed");
    assert_eq!(refused["version"], 2);
    assert_eq!(session.exit_code(Duration::from_secs(5)), Some(78));
}

#[test]
fn cancel_ends_a_lease_and_the_session_continues() {
    let fixture = Fixture::new();
    fixture.write("cancel me");
    let mut session = Session::start(&fixture.root(), 10_000);
    session.event();
    session.read();
    session.send(json!({"type":"cancel","version":2}));
    assert_eq!(session.event()["type"], "cancelled");
    assert_eq!(text(&session.read()), "cancel me");
}

#[test]
fn a_missing_leaf_is_reported_on_protocol_two() {
    let fixture = Fixture::new();
    let mut session = Session::start(&fixture.root(), 10_000);
    session.event();
    let refused = session.read();
    assert_eq!(refused["type"], "error");
    assert_eq!(refused["version"], 2);
    assert_eq!(refused["code"], "history-leaf-missing");
    assert_eq!(session.exit_code(Duration::from_secs(5)), Some(78));
}

#[test]
fn an_idle_session_exits_by_itself() {
    let fixture = Fixture::new();
    let mut session = Session::start(&fixture.root(), 200);
    session.event();
    assert_eq!(session.exit_code(Duration::from_secs(5)), Some(0));
}

#[test]
fn a_lease_held_past_its_deadline_ends_the_process() {
    let fixture = Fixture::new();
    fixture.write("expires");
    let mut session = Session::start(&fixture.root(), 10_000);
    session.event();
    session.send(json!({"type":"read","version":2,"components":["session-a","snapshot.json"],"maxBytes":4096,"deadlineMs":300}));
    assert_eq!(session.event()["type"], "snapshot");
    assert_eq!(session.exit_code(Duration::from_secs(5)), Some(75));
    fs::rename(fixture.root(), fixture.0.join("free")).unwrap();
}

#[test]
fn a_read_blocked_on_output_still_ends_at_its_deadline() {
    let fixture = Fixture::new();
    // Far more than a pipe buffer: publishing it blocks while nobody reads the output.
    fixture.write(&"x".repeat(1024 * 1024));
    let mut session = Session::start(&fixture.root(), 10_000);
    session.event();
    session.send(json!({"type":"read","version":2,"components":["session-a","snapshot.json"],"maxBytes":2 * 1024 * 1024,"deadlineMs":300}));
    assert_eq!(session.exit_code(Duration::from_secs(5)), Some(75));
    fs::rename(fixture.root(), fixture.0.join("free")).unwrap();
}

#[test]
fn version_one_commands_and_extra_fields_are_refused() {
    let fixture = Fixture::new();
    for line in [
        json!({"type":"read","version":1,"components":["session-a","snapshot.json"],"maxBytes":4096,"deadlineMs":5000}),
        json!({"type":"close","version":2,"actor":"foreign"}),
        json!({"type":"release","version":2}),
    ] {
        let mut session = Session::start(&fixture.root(), 10_000);
        session.event();
        session.send(line);
        assert_eq!(session.event()["type"], "error");
        assert_eq!(session.exit_code(Duration::from_secs(5)), Some(78));
    }
}
