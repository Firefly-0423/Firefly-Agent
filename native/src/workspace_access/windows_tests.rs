use super::*;
use std::{fs, os::windows::fs::OpenOptionsExt, path::{Path, PathBuf}, sync::mpsc, thread};
#[path = "../../tests/support/workspace_links.rs"]
mod links;

struct Fixture { base: PathBuf, root: PathBuf, outside: PathBuf }
impl Fixture {
    fn new() -> Self {
        testing::HOOK.with(|v| *v.borrow_mut() = None);
        testing::IOS.with(|v| v.borrow_mut().clear());
        let base = PathBuf::from(std::env::var_os("FF_WORKSPACE_TEST_ROOT").expect("isolated test root")).join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&base).unwrap();
        let root = base.join("workspace"); let outside = base.join("external");
        fs::create_dir(&root).unwrap(); fs::create_dir(&outside).unwrap();
        let probe = root.join("unheld-rename-probe"); fs::create_dir(&probe).unwrap();
        fs::rename(&probe, root.join("unheld-rename-moved")).expect("unheld directory renames must work for the race fixture");
        fs::remove_dir(root.join("unheld-rename-moved")).unwrap();
        fs::write(outside.join("sentinel"), b"external sentinel").unwrap();
        Self { base, root, outside }
    }
    fn sentinel(&self) -> (Vec<u8>, Vec<String>, Identity, Identity) {
        let mut names: Vec<String> = fs::read_dir(&self.outside).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect(); names.sort();
        (fs::read(self.outside.join("sentinel")).unwrap(), names,
            identity(inspect(&File::open(self.outside.join("sentinel")).unwrap()).unwrap()),
            identity(inspect(&fs::OpenOptions::new().read(true).custom_flags(0x02000000).open(&self.outside).unwrap()).unwrap()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        testing::HOOK.with(|v| *v.borrow_mut() = None);
        let (Ok(canonical), Ok(parent)) = (fs::canonicalize(&self.base), fs::canonicalize(self.base.parent().unwrap())) else {
            eprintln!("fixture retained: cannot verify cleanup target {}", self.base.display());
            return;
        };
        assert_eq!(canonical.parent(), Some(parent.as_path()));
        assert_eq!(canonical.file_name(), self.base.file_name());
        fs::remove_dir_all(&self.base).unwrap();
    }
}
fn names(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }
#[test]
fn history_reader_retains_native_open_error_contract() {
    let f = Fixture::new();
    fs::write(f.root.join("file"), b"before").unwrap();
    let root = WindowsRoot::open(&f.root).unwrap();
    let _writer = root.prepare_write(&names(&["file"]), false).unwrap();
    let history = crate::history_read::AuthorizedHistoryRoot::open(&f.root).unwrap();
    let error = history.open_snapshot(&names(&["file"]), 32).unwrap_err();
    assert!(matches!(error, HandleError::OpenFailed(code) if code == 0xc0000043u32 as i32), "{error:?}");
    assert_eq!(error.code(), "history-native-open-failed");
}
#[test]
fn replace_failure_preserves_unwritten_tail() {
    let f = Fixture::new();
    fs::write(f.root.join("file"), b"original tail").unwrap();
    let root = WindowsRoot::open(&f.root).unwrap();
    let mut lease = root.prepare_write(&names(&["file"]), false).unwrap();
    let id = lease.before().identity;
    testing::WRITE_LIMIT.with(|v| v.set(Some(3)));
    assert!(lease.commit(WriteMode::Replace, b"replacement").is_err());
    testing::WRITE_LIMIT.with(|v| v.set(None));
    let file = lease.file.as_mut().unwrap();
    assert_eq!(Some(identity(inspect(file).unwrap())), id);
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut bytes = Vec::new(); file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"repginal tail");
}
fn junction(link: &Path, target: &Path) {
    links::junction(link, target).expect("junction fixture creation");
}
fn relative_junction(parent: &Path, name: &str, target: &Path, create: bool) -> std::io::Result<()> {
    let parent = crate::handle_fs::open_with_disposition(None, &format!("\\??\\{}", parent.display()), Some(true), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN)
        .map_err(std::io::Error::other)?;
    let child = crate::handle_fs::open_with_disposition(Some(&parent), name, Some(true), FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, if create { FILE_CREATE } else { FILE_OPEN })
        .map_err(std::io::Error::other)?;
    links::set_junction(&child, target)
}
/// Channels are a deterministic two-party barrier. Only cfg(test) contains it;
/// the attacker runs on an independent OS thread, not inside the I/O thread.
fn attack_at<T: Send + 'static>(stage: testing::Stage, attack: impl FnOnce() -> T + Send + 'static) -> thread::JoinHandle<T> {
    let (start, wait) = mpsc::sync_channel(0); let (done, resume) = mpsc::sync_channel(0);
    let attacker = thread::spawn(move || {
        wait.recv_timeout(std::time::Duration::from_secs(5)).unwrap(); let outcome = attack(); done.send(()).unwrap(); outcome
    });
    let mut fired = false;
    testing::HOOK.with(|v| *v.borrow_mut() = Some(Box::new(move |seen| {
        if seen == stage && !fired { fired = true; start.send(()).unwrap(); resume.recv_timeout(std::time::Duration::from_secs(5)).unwrap(); }
    })));
    attacker
}
fn assert_no_external_io(outside: Identity) {
    testing::IOS.with(|v| assert!(v.borrow().iter().all(|(_, id)| *id != outside), "external handle entered I/O"));
}
#[test]
fn swapped_unopened_component_fails_read_stat_list_image_and_write_prepare() {
    for op in ["read", "image", "stat", "list", "replace", "append"] {
        let f = Fixture::new(); let sentinel = f.sentinel();
        let probe = f.root.join("junction-probe"); junction(&probe, &f.outside); fs::remove_dir(probe).unwrap();
        fs::create_dir_all(f.root.join("anchor/target")).unwrap();
        let root = WindowsRoot::open(&f.root).unwrap();
        let parent = f.root.join("anchor"); let outside = f.outside.clone();
        let attacker = attack_at(testing::Stage::Ancestor, move || {
            relative_junction(&parent, "target", &outside, false).expect("native attacker must inject an unheld reparse point"); true
        });
        let path = names(&["anchor", "target", "sentinel"]);
        let failed = match op {
            "read" | "image" => root.read(&path, 64).is_err(),
            "stat" => root.stat(&path).is_err(),
            "list" => root.list(&names(&["anchor", "target"])).is_err(),
            _ => match root.prepare_write(&path, true) {
                Ok(mut file) => file.commit(if op == "append" { WriteMode::Append } else { WriteMode::Replace }, b"local").is_err(),
                Err(_) => true,
            },
        };
        let swapped = attacker.join().unwrap();
        if swapped { assert!(failed, "{op} followed swapped junction"); }
        else { assert!(!failed, "a denied attack must still operate on the pinned local object"); }
        assert_eq!(f.sentinel(), sentinel); assert_no_external_io(sentinel.2);
        if swapped { assert!(testing::IOS.with(|v| v.borrow().is_empty())); }
        drop(root); if swapped { fs::remove_dir(f.root.join("anchor/target")).unwrap(); }
    }
}
#[test]
fn parent_open_create_race_cannot_create_in_external_directory() {
    for parent_creation in [false, true] {
        let f = Fixture::new(); let sentinel = f.sentinel();
        let probe = f.root.join("junction-probe"); junction(&probe, &f.outside); fs::remove_dir(probe).unwrap();
        fs::create_dir(f.root.join("anchor")).unwrap();
        let root = WindowsRoot::open(&f.root).unwrap();
        let path = if parent_creation { names(&["anchor", "missing", "new"]) } else { names(&["anchor", "new"]) };
        let mut file = root.prepare_write(&path, true).unwrap();
        let parent = f.root.join("anchor"); let outside = f.outside.clone();
        let attacker = attack_at(testing::Stage::ParentCreate, move || {
            relative_junction(&parent, if parent_creation { "missing" } else { "new" }, &outside, true).expect("native attacker must insert the junction"); true
        });
        let result = file.commit(WriteMode::Replace, b"must not escape"); let swapped = attacker.join().unwrap();
        match result {
            Ok(after) => { assert!(!swapped); assert_eq!(after.bytes.unwrap(), b"must not escape"); assert_ne!(after.identity, Some(sentinel.2)); },
            Err(_) => { assert!(testing::IOS.with(|v| v.borrow().is_empty()), "rejected create must perform no content I/O"); },
        }
        assert_eq!(f.sentinel(), sentinel); assert_no_external_io(sentinel.2);
        assert!(!f.outside.join("new").exists());
        drop(file); drop(root); if swapped { fs::remove_dir(f.root.join(if parent_creation { "anchor/missing" } else { "anchor/new" })).unwrap(); }
    }
}
#[test]
fn leaf_open_io_race_denies_swap_and_rechecks_links_before_truncation() {
    for mode in [WriteMode::Replace, WriteMode::Append] {
        let f = Fixture::new(); let sentinel = f.sentinel();
        fs::create_dir(f.root.join("anchor")).unwrap(); fs::write(f.root.join("anchor/file"), b"keep inside").unwrap();
        let root = WindowsRoot::open(&f.root).unwrap();
        let mut file = root.prepare_write(&names(&["anchor", "file"]), false).unwrap();
        testing::IOS.with(|v| v.borrow_mut().clear());
        let anchor = f.root.join("anchor"); let leaf = anchor.join("file"); let alias = f.root.join("alias");
        let attacker = attack_at(testing::Stage::BeforeIo, move || {
            assert!(fs::rename(&anchor, anchor.with_extension("moved")).is_err());
            assert!(fs::rename(&leaf, leaf.with_extension("moved")).is_err());
            match links::hard_link(&leaf, &alias) {
                Ok(()) => true,
                Err(error) => { assert_eq!(error.raw_os_error(), Some(32)); false },
            }
        });
        let result = file.commit(mode, b"bad"); let alias_created = attacker.join().unwrap();
        if alias_created {
            assert!(result.is_err());
            assert_eq!(fs::read(f.root.join("anchor/file")).unwrap(), b"keep inside");
            assert!(testing::IOS.with(|v| v.borrow().is_empty()));
        } else {
            let after = result.unwrap(); assert_eq!(after.identity, file.before().identity);
            assert_eq!(after.bytes.unwrap(), if matches!(mode, WriteMode::Append) { b"keep insidebad".to_vec() } else { b"bad".to_vec() });
        }
        assert_eq!(f.sentinel(), sentinel); assert_no_external_io(sentinel.2);
    }
}
#[test]
fn pinned_parent_creation_and_handle_listing_resist_directory_replacement() {
    let f = Fixture::new(); let sentinel = f.sentinel();
    fs::create_dir(f.root.join("anchor")).unwrap();
    let root = WindowsRoot::open(&f.root).unwrap();
    let mut file = root.prepare_write(&names(&["anchor", "new"]), false).unwrap();
    let anchor = f.root.join("anchor");
    let attacker = attack_at(testing::Stage::ParentCreate, move || { assert!(fs::rename(&anchor, anchor.with_extension("moved")).is_err()); });
    let after = file.commit(WriteMode::Replace, b"local").unwrap(); attacker.join().unwrap();
    assert_ne!(after.identity, Some(sentinel.2)); drop(file);
    let anchor = f.root.join("anchor");
    let attacker = attack_at(testing::Stage::Leaf, move || { assert!(fs::rename(&anchor, anchor.with_extension("moved")).is_err()); });
    let entries = root.list(&names(&["anchor"])).unwrap(); attacker.join().unwrap();
    assert_eq!(entries.len(), 1); assert_eq!(entries[0].name, "new");
    assert_eq!(f.sentinel(), sentinel); assert_no_external_io(sentinel.2);
    assert!(testing::IOS.with(|v| v.borrow().iter().any(|(op, _)| *op == "list")));
}
#[test]
fn research_double_swap_is_rejected_before_external_open_then_second_swap_is_denied() {
    let f = Fixture::new(); let sentinel = f.sentinel();
    fs::create_dir(f.root.join("ordinary")).unwrap(); fs::write(f.root.join("ordinary/sentinel"), b"inside").unwrap();
    junction(&f.root.join("d"), &f.outside);
    let root = WindowsRoot::open(&f.root).unwrap();
    // Report's first step would obtain an external fd. Our first relative open rejects it.
    assert!(root.read(&names(&["d", "sentinel"]), 64).is_err());
    assert!(testing::IOS.with(|v| v.borrow().is_empty()));
    drop(root); // The rejected acquisition produced no external descriptor to retain.
    let d = f.root.join("d"); let ordinary = f.root.join("ordinary");
    thread::spawn(move || { fs::remove_dir(&d).unwrap(); fs::rename(ordinary, d).unwrap(); }).join().unwrap();
    let root = WindowsRoot::open(&f.root).unwrap();
    let d = f.root.join("d");
    let attacker = attack_at(testing::Stage::Ancestor, move || {
        // Report's second swap, after a path check, cannot move this held ancestor.
        assert!(fs::rename(&d, d.with_extension("saved")).is_err());
    });
    assert_eq!(root.read(&names(&["d", "sentinel"]), 64).unwrap().bytes.unwrap(), b"inside"); attacker.join().unwrap();
    assert_eq!(f.sentinel(), sentinel); assert_no_external_io(sentinel.2);
}
#[test]
fn root_swap_is_denied_while_root_and_ancestors_are_pinned() {
    let f = Fixture::new(); let sentinel = f.sentinel(); let root_path = f.root.clone();
    let attacker = attack_at(testing::Stage::Root, move || { assert!(fs::rename(&root_path, root_path.with_extension("moved")).is_err()); });
    let root = WindowsRoot::open(&f.root).unwrap(); attacker.join().unwrap();
    assert!(root.list(&[]).unwrap().is_empty()); assert_eq!(f.sentinel(), sentinel);
}
#[test]
fn canonical_name_is_queried_from_the_pinned_handle() {
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, VOLUME_NAME_NONE};
    let f = Fixture::new(); fs::write(f.root.join("MiXeD"), b"inside").unwrap();
    let root = WindowsRoot::open(&f.root).unwrap();
    let (_ancestors, file) = root.entry(&names(&["mixed"]), FILE_READ_DATA).unwrap();
    let mut buffer = vec![0u16; 32768];
    let count = unsafe { GetFinalPathNameByHandleW(raw(&file), &mut buffer, VOLUME_NAME_NONE) };
    assert!(count > 0 && count < buffer.len() as u32, "handle name query failed: {:?}", std::io::Error::last_os_error());
    let name = String::from_utf16(&buffer[..count as usize]).unwrap();
    assert!(name.ends_with("\\MiXeD"), "{name}");
}
