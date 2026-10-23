#![cfg(all(windows, feature = "history-read"))]
use firefly_screenshot::history_read::AuthorizedHistoryRoot;
use std::{fs, path::PathBuf};

// FF_HISTORY_TEST_ROOT overrides the existing TEMP/TMP isolation convention.
// The harness must create its isolated E root first; never fall back to C.
struct Fixture(PathBuf, PathBuf);
impl Fixture {
    fn new() -> Self {
        let base = std::env::var_os("FF_HISTORY_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        assert!(
            base.is_absolute()
                && base
                    .components()
                    .any(|c| matches!(c, std::path::Component::Normal(_)))
                && matches!(base.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(d) if d.eq_ignore_ascii_case(&b'E')))
                && !base
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)),
            "configure an existing isolated absolute E root via FF_HISTORY_TEST_ROOT or TEMP/TMP"
        );
        let canonical = fs::canonicalize(&base).expect("isolated test root must already exist");
        assert!(
            matches!(canonical.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::VerbatimDisk(d) | std::path::Prefix::Disk(d) if d.eq_ignore_ascii_case(&b'E'))),
            "test root must resolve on E"
        );
        let path = base.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&path).unwrap();
        Self(path, canonical)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let resolved =
            fs::canonicalize(&self.0).expect("owned fixture must resolve before deletion");
        assert!(
            resolved.is_absolute()
                && resolved.parent() == Some(self.1.as_path())
                && resolved.file_name() == self.0.file_name()
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn authorized_existing_regular_file_is_read_without_repair() {
    let fixture = Fixture::new();
    let content = b"synthetic transcript\ntruncated-tail";
    fs::write(fixture.0.join("history.jsonl"), content).unwrap();
    let root = AuthorizedHistoryRoot::open(&fixture.0)
        .expect("authorized native root should be available");
    let lease = root
        .open_snapshot(&["history.jsonl".into()], 128)
        .expect("read a bounded existing synthetic file");
    assert_eq!(lease.bytes(), content);
    drop(lease);
    drop(root);
    assert_eq!(fs::read(fixture.0.join("history.jsonl")).unwrap(), content);
}

#[test]
fn lease_survives_root_owner_drop_and_blocks_file_and_directory_replacement() {
    let fixture = Fixture::new();
    let nested = fixture.0.join("nested");
    fs::create_dir(&nested).unwrap();
    let leaf = nested.join("history.jsonl");
    fs::write(&leaf, b"original").unwrap();
    let root = AuthorizedHistoryRoot::open(&fixture.0).unwrap();
    let lease = root
        .open_snapshot(&["nested".into(), "history.jsonl".into()], 64)
        .unwrap();
    drop(root);
    assert!(fs::rename(&fixture.0, fixture.0.with_extension("moved")).is_err());
    assert!(fs::rename(&nested, fixture.0.join("replacement")).is_err());
    assert!(fs::rename(&leaf, nested.join("replacement.jsonl")).is_err());
    assert!(fs::remove_file(&leaf).is_err());
    assert!(fs::write(&leaf, b"modified").is_err());
    assert_eq!(lease.bytes(), b"original");
    drop(lease);
    fs::rename(&leaf, nested.join("replacement.jsonl")).unwrap();
    fs::rename(&nested, fixture.0.join("replacement")).unwrap();
    let moved = fixture.0.with_extension("moved");
    fs::rename(&fixture.0, &moved).unwrap();
    fs::rename(&moved, &fixture.0).unwrap();
}
#[test]
fn bounds_empty_and_invalid_relative_paths() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("empty"), b"").unwrap();
    fs::write(fixture.0.join("two"), b"12").unwrap();
    let root = AuthorizedHistoryRoot::open(&fixture.0).unwrap();
    assert_eq!(
        root.open_snapshot(&["empty".into()], 1).unwrap().bytes(),
        b""
    );
    assert_eq!(
        root.open_snapshot(&["two".into()], 2).unwrap().bytes(),
        b"12"
    );
    assert!(root.open_snapshot(&["two".into()], 1).is_err());
    assert!(root.open_snapshot(&["two".into()], 0).is_err());
    assert!(
        root.open_snapshot(&["empty".into()], 4 * 1024 * 1024 + 1)
            .is_err()
    );
    assert!(root.open_snapshot(&[], 16).is_err());
    assert!(root.open_snapshot(&vec!["sub".into(); 17], 16).is_err());
    for component in [
        "", ".", "..", "x/y", "x\\y", "x:stream", "x\0", "x.", "x ", "CON", "NUL.txt", "COM1",
        "lpt9", "COM¹", "CONIN$", "CONOUT$", "x?", "x*",
    ] {
        assert!(
            root.open_snapshot(&[component.into()], 16).is_err(),
            "accepted {component:?}"
        );
    }
    assert!(root.open_snapshot(&["🦋".repeat(128)], 16).is_err());
}
#[test]
fn missing_root_and_leaf_are_never_created() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("missing");
    assert!(AuthorizedHistoryRoot::open(&missing).is_err());
    assert!(!missing.exists());
    let root = AuthorizedHistoryRoot::open(&fixture.0).unwrap();
    assert!(root.open_snapshot(&["missing".into()], 32).is_err());
    assert!(!missing.exists());
}
fn junction(link: &std::path::Path, target: &std::path::Path) {
    let output = std::process::Command::new("cmd.exe")
        .arg("/d")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction creation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn existing_root_and_ancestor_junction_and_hardlink_are_rejected() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.0.join("external"), b"outside synthetic content").unwrap();
    junction(&fixture.0.join("linked-root"), &outside.0);
    assert!(AuthorizedHistoryRoot::open(&fixture.0.join("linked-root")).is_err());
    fs::hard_link(outside.0.join("external"), fixture.0.join("hardlink")).unwrap();
    let root = AuthorizedHistoryRoot::open(&fixture.0).unwrap();
    assert!(
        root.open_snapshot(&["linked-root".into(), "external".into()], 64)
            .is_err()
    );
    assert!(root.open_snapshot(&["hardlink".into()], 64).is_err());
    drop(root);
    fs::remove_dir(fixture.0.join("linked-root")).unwrap();
}
#[test]
fn existing_write_handle_causes_fail_closed_without_mutation() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let file = fixture.0.join("history");
    fs::write(&file, b"original").unwrap();
    let writer = fs::OpenOptions::new()
        .write(true)
        .share_mode(7)
        .open(&file)
        .unwrap();
    let root = AuthorizedHistoryRoot::open(&fixture.0).unwrap();
    assert!(root.open_snapshot(&["history".into()], 64).is_err());
    drop(writer);
    assert_eq!(
        root.open_snapshot(&["history".into()], 64).unwrap().bytes(),
        b"original"
    );
}

#[test]
fn final_missing_leaf_is_distinct_from_missing_ancestor() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("session")).unwrap();
    let root = AuthorizedHistoryRoot::open(&fixture.0).unwrap();
    let leaf = root
        .open_snapshot(&["session".into(), "snapshot.json".into()], 128)
        .err()
        .unwrap();
    assert_eq!(leaf.code(), "history-leaf-missing");
    let ancestor = root
        .open_snapshot(&["absent".into(), "snapshot.json".into()], 128)
        .err()
        .unwrap();
    assert_eq!(ancestor.code(), "history-native-open-failed");
}
