#![cfg(all(windows, feature = "workspace-handle"))]
use firefly_screenshot::workspace_access::{WorkspaceRoot, WorkspaceBackend, WorkspaceFile, WriteMode};
use std::{fs, path::PathBuf};
#[path = "support/workspace_links.rs"]
mod links;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let base = PathBuf::from(std::env::var_os("FF_WORKSPACE_TEST_ROOT").expect("isolated test root"));
        assert!(base.is_absolute());
        let path = base.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let (Ok(canonical), Ok(base)) = (fs::canonicalize(&self.0), fs::canonicalize(self.0.parent().unwrap())) else {
            eprintln!("fixture retained: cannot verify cleanup target {}", self.0.display());
            return;
        };
        assert_eq!(canonical.parent(), Some(base.as_path()));
        assert_eq!(canonical.file_name(), self.0.file_name());
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn parts(names: &[&str]) -> Vec<String> { names.iter().map(|s| s.to_string()).collect() }
#[test]
fn reader_writer_contention_is_not_boundary() {
    let f = Fixture::new();
    fs::write(f.0.join("file"), b"before").unwrap();
    let writer = WorkspaceRoot::open(&f.0).unwrap();
    let mut lease = writer.prepare_write(&parts(&["file"]), false).unwrap();
    let reader = WorkspaceRoot::open(&f.0).unwrap();
    let error = reader.read(&parts(&["file"]), 32).unwrap_err();
    assert_eq!(error.to_string(), "workspace-busy");
    assert_eq!(serde_json::to_value(error.reason()).unwrap(), "sharing-violation");
    assert_eq!(lease.commit(WriteMode::Replace, b"after").unwrap().bytes.unwrap(), b"after");
    drop(lease);
    assert_eq!(reader.read(&parts(&["file"]), 32).unwrap().bytes.unwrap(), b"after");
}
fn junction(link: &std::path::Path, target: &std::path::Path) {
    links::junction(link, target).expect("junction fixture creation");
}
#[test]
fn read_write_append_stat_and_handle_listing() {
    let f = Fixture::new();
    fs::write(f.0.join("Mixed.txt"), b"original").unwrap();
    let root = WorkspaceRoot::open(&f.0).unwrap();
    assert_eq!(root.read(&[], 32).unwrap().kind, firefly_screenshot::workspace_access::Kind::Directory);
    let mut file = root.prepare_write(&parts(&["mixed.TXT"]), false).unwrap();
    assert_eq!(file.before().bytes.as_deref(), Some(b"original".as_slice()));
    let id = file.before().identity;
    let after = file.commit(WriteMode::Replace, b"new").unwrap();
    assert_eq!(after.identity, id);
    assert_eq!(after.bytes.as_deref(), Some(b"new".as_slice()));
    drop(file);
    let mut file = root.prepare_write(&parts(&["Mixed.txt"]), false).unwrap();
    let after = file.commit(WriteMode::Append, b" tail").unwrap();
    assert_eq!(after.bytes.as_deref(), Some(b"new tail".as_slice()));
    drop(file);
    assert_eq!(root.stat(&parts(&["Mixed.txt"])).unwrap().size, 8);
    let entries = root.list(&[]).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "Mixed.txt");
    assert_eq!(entries[0].size, 8);
    assert_eq!(root.read(&parts(&["Mixed.txt"]), 32).unwrap().bytes.unwrap(), b"new tail");
}
#[test]
fn create_missing_parents_and_file_without_truncation_during_prepare() {
    let f = Fixture::new();
    fs::write(f.0.join("keep"), b"do not truncate").unwrap();
    let root = WorkspaceRoot::open(&f.0).unwrap();
    let file = root.prepare_write(&parts(&["keep"]), true).unwrap();
    assert_eq!(fs::read(f.0.join("keep")).unwrap(), b"do not truncate");
    drop(file);
    let mut file = root.prepare_write(&parts(&["a", "b", "new"]), true).unwrap();
    assert!(!file.before().exists);
    assert!(!f.0.join("a").exists(), "prepare cannot create parents");
    assert_eq!(file.commit(WriteMode::Replace, b"created").unwrap().bytes.unwrap(), b"created");
    drop(file);
    assert_eq!(fs::read(f.0.join("a/b/new")).unwrap(), b"created");
}
#[test]
fn root_mid_leaf_reparse_fail_before_io_or_truncate() {
    let f = Fixture::new(); let outside = Fixture::new();
    fs::write(outside.0.join("sentinel"), b"external").unwrap();
    junction(&f.0.join("link"), &outside.0);
    assert!(WorkspaceRoot::open(&f.0.join("link")).is_err());
    let root = WorkspaceRoot::open(&f.0).unwrap();
    assert!(root.read(&parts(&["link", "sentinel"]), 32).is_err());
    assert!(root.list(&parts(&["link"])).is_err());
    assert!(root.stat(&parts(&["link"])).is_err());
    assert!(root.prepare_write(&parts(&["link", "sentinel"]), true).is_err());
    assert!(root.read(&parts(&["link"]), 32).is_err());
    assert!(root.prepare_write(&parts(&["link"]), false).is_err());
    assert!(root.list(&[]).is_err());
    assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"external");
    drop(root); fs::remove_dir(f.0.join("link")).unwrap();
}
#[test]
fn existing_hardlinks_fail_read_stat_list_and_write_without_truncation() {
    let f = Fixture::new(); let outside = Fixture::new();
    fs::write(outside.0.join("sentinel"), b"external").unwrap();
    links::hard_link(&outside.0.join("sentinel"), &f.0.join("alias")).unwrap();
    let root = WorkspaceRoot::open(&f.0).unwrap();
    assert!(root.read(&parts(&["alias"]), 32).is_err());
    assert!(root.prepare_write(&parts(&["alias"]), false).is_err());
    assert!(root.stat(&parts(&["alias"])).is_err());
    assert!(root.list(&[]).is_err());
    assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"external");
}
#[test]
fn names_ads_devices_trailing_characters_and_long_prefixed_paths() {
    let f = Fixture::new();
    let root = WorkspaceRoot::open(&f.0).unwrap();
    for name in ["", ".", "..", "file:stream", "CON", "nul.txt", "LPT9", "COM¹", "x.", "x ", "x/y", "x\\y", "x\0"] {
        assert!(root.prepare_write(&parts(&[name]), true).is_err(), "accepted {name:?}");
    }
    drop(root);
    let long = f.0.join("a".repeat(120)).join("b".repeat(120));
    fs::create_dir_all(&long).unwrap(); fs::write(long.join("file"), b"long").unwrap();
    let prefixed = PathBuf::from(format!("\\\\?\\{}", long.display()));
    let root = WorkspaceRoot::open(&prefixed).unwrap();
    assert_eq!(root.read(&parts(&["FILE"]), 8).unwrap().bytes.unwrap(), b"long");
}
