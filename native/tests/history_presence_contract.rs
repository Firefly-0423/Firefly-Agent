#![cfg(all(windows, feature = "history-read"))]
use firefly_screenshot::history_read::{AuthorizedHistoryRoot, SnapshotPresence};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
};

fn fixture() -> PathBuf {
    let base =
        PathBuf::from(std::env::var_os("FF_HISTORY_TEST_ROOT").expect("E fixture root required"));
    assert!(
        base.is_absolute()
            && base.components().any(|c| matches!(c, std::path::Component::Normal(_)))
            && matches!(base.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(d) if d.eq_ignore_ascii_case(&b'E')))
            && !base.components().any(|c| matches!(c, std::path::Component::ParentDir)),
        "configure an existing isolated absolute E root via FF_HISTORY_TEST_ROOT"
    );
    let canonical = fs::canonicalize(&base).expect("isolated test root must already exist");
    assert!(
        matches!(canonical.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::VerbatimDisk(d) | std::path::Prefix::Disk(d) if d.eq_ignore_ascii_case(&b'E'))),
        "test root must resolve on E"
    );
    let result = base.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&result).unwrap();
    result
}
#[test]
fn metadata_observation_is_not_a_body_read_or_repair() {
    let p = fixture();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert_eq!(
        root.probe_snapshot_presence("a"),
        SnapshotPresence::Missing {
            component: "transcripts"
        }
    );
    drop(root);
    fs::create_dir(p.join("transcripts")).unwrap();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert_eq!(
        root.probe_snapshot_presence("a"),
        SnapshotPresence::Missing {
            component: "session"
        }
    );
    drop(root);
    fs::create_dir(p.join("transcripts/a")).unwrap();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert_eq!(
        root.probe_snapshot_presence("a"),
        SnapshotPresence::Missing {
            component: "snapshot"
        }
    );
    drop(root);
    let leaf = p.join("transcripts/a/snapshot.json");
    fs::write(&leaf, b"invalid-json synthetic body never parsed").unwrap();
    let before = fs::read(&leaf).unwrap();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert_eq!(root.probe_snapshot_presence("a"), SnapshotPresence::Present);
    for id in ["..", "../a", "NUL", "a.", "a:stream"] {
        assert_eq!(
            root.probe_snapshot_presence(id),
            SnapshotPresence::UnknownDenied {
                reason: "history-invalid-path"
            }
        );
    }
    drop(root);
    assert_eq!(fs::read(&leaf).unwrap(), before);
    fs::remove_dir_all(p).unwrap();
}
#[test]
fn wrong_type_and_hardlink_are_unknown_not_missing() {
    let p = fixture();
    fs::create_dir_all(p.join("transcripts/a/snapshot.json")).unwrap();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert!(matches!(
        root.probe_snapshot_presence("a"),
        SnapshotPresence::UnknownDenied { .. }
    ));
    drop(root);
    fs::remove_dir(p.join("transcripts/a/snapshot.json")).unwrap();
    fs::write(p.join("transcripts/a/snapshot.json"), "synthetic").unwrap();
    fs::hard_link(p.join("transcripts/a/snapshot.json"), p.join("alias")).unwrap();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert_eq!(
        root.probe_snapshot_presence("a"),
        SnapshotPresence::UnknownDenied {
            reason: "history-multiple-links"
        }
    );
    drop(root);
    fs::remove_dir_all(p).unwrap();
}
#[test]
fn helper_protocol_is_metadata_only_and_rejects_content_commands() {
    let p = fixture();
    fs::create_dir_all(p.join("transcripts/a")).unwrap();
    fs::write(
        p.join("transcripts/a/snapshot.json"),
        "SECRET_SYNTHETIC_BODY",
    )
    .unwrap();
    for (command, expected_type) in [
        (
            r#"{"type":"probe","version":1,"sessionIds":["a","missing","../escape"]}"#,
            "results",
        ),
        (
            r#"{"type":"read","version":1,"components":["snapshot.json"]}"#,
            "error",
        ),
        (
            r#"{"type":"probe","version":1,"sessionIds":["a"],"root":"foreign"}"#,
            "error",
        ),
        (r#"{"type":"cancel","version":1}"#, "cancelled"),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_firefly-history-presence"))
            .args([
                "--root",
                p.to_str().unwrap(),
                "--parent-pid",
                &std::process::id().to_string(),
                "--deadline-ms",
                "3000",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&ready).unwrap()["type"],
            "ready"
        );
        writeln!(stdin, "{command}").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert!(!line.contains("SECRET_SYNTHETIC_BODY"));
        assert!(!line.contains(p.to_str().unwrap()));
        let event: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(event["type"], expected_type);
        if expected_type == "results" {
            assert_eq!(event["observations"][0]["status"], "present");
            assert_eq!(event["observations"][1]["status"], "missing");
            assert_eq!(event["observations"][2]["status"], "unknown-denied");
            writeln!(stdin, "{{\"type\":\"cancel\",\"version\":1}}").unwrap();
        }
        drop(stdin);
        let _ = child.wait().unwrap();
    }
    fs::remove_dir_all(p).unwrap();
}

#[test]
fn directory_sharing_denial_is_unknown_and_does_not_fall_back_to_reading() {
    use std::os::windows::fs::OpenOptionsExt;
    let p = fixture();
    fs::create_dir_all(p.join("transcripts/a")).unwrap();
    let leaf = p.join("transcripts/a/snapshot.json");
    fs::write(&leaf, "synthetic").unwrap();
    // Leaf attributes-only opens do not require a data-read share. An exclusive
    // directory handle conflicts with the ancestor LIST_DIRECTORY access.
    let writer = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS, directory open only.
        .open(p.join("transcripts"))
        .unwrap();
    let root = AuthorizedHistoryRoot::open(&p).unwrap();
    assert_eq!(
        root.probe_snapshot_presence("a"),
        SnapshotPresence::UnknownDenied {
            reason: "history-native-open-failed"
        }
    );
    drop(root);
    drop(writer);
    fs::remove_dir_all(p).unwrap();
}
#[test]
fn helper_watchdog_bounds_partial_input() {
    let p = fixture();
    let mut child = Command::new(env!("CARGO_BIN_EXE_firefly-history-presence"))
        .args([
            "--root",
            p.to_str().unwrap(),
            "--parent-pid",
            &std::process::id().to_string(),
            "--deadline-ms",
            "250",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&ready).unwrap()["type"],
        "ready"
    );
    stdin.write_all(b"{\"type\":").unwrap();
    stdin.flush().unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(75));
    drop(stdin);
    fs::remove_dir_all(p).unwrap();
}
