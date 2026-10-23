//! Dormant Windows history acquisition. No actor/session authorization or Main caller.
//! Captured bytes are immutable; this does not promise an atomic source snapshot
//! against a pre-existing writable memory mapping. Read sharing also does not
//! freeze the hardlink table: each read checks observed link count, and metadata
//! is checked again afterward. Handle-relative ancestry proves object traversal.
use std::{
    fs::File,
    io::Read,
    os::windows::io::OwnedHandle,
    path::Path,
    sync::Arc,
};
use windows::Win32::Storage::FileSystem::{FILE_ACCESS_RIGHTS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, SYNCHRONIZE};

pub const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_COMPONENTS: usize = 16;
pub use crate::handle_fs::{HandleError as HistoryReadError, FileIdentity};
use crate::handle_fs::{inspect, validate_type, validate_local_ntfs, valid_component};
/// Point-in-time metadata observation, never a content/evidence lease.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SnapshotPresence {
    Present,
    Missing { component: &'static str },
    UnknownDenied { reason: &'static str },
}
fn precise_absence(error: &HistoryReadError) -> bool {
    // STATUS_NO_SUCH_FILE / STATUS_OBJECT_NAME_NOT_FOUND only. PATH_NOT_FOUND
    // is ambiguous and must not be silently promoted to absence.
    matches!(error, HistoryReadError::OpenFailed(code) if [0xc000000fu32 as i32, 0xc0000034u32 as i32].contains(code))
}
#[derive(Debug)]
pub struct AuthorizedHistoryRoot {
    handle: Arc<OwnedHandle>,
    identity: FileIdentity,
}
#[derive(Debug)]
pub struct HistorySnapshotLease {
    bytes: Box<[u8]>,
    identity: FileIdentity,
    // Root/ancestors and leaf outlive the published immutable bytes.
    _directories: Vec<Arc<OwnedHandle>>,
    _leaf: File,
}
impl HistorySnapshotLease {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn identity(&self) -> FileIdentity {
        self.identity
    }
}
impl AuthorizedHistoryRoot {
    pub fn open(path: &Path) -> Result<Self, HistoryReadError> {
        let path = path.to_str().ok_or(HistoryReadError::InvalidRoot)?;
        let raw = path.as_bytes();
        if raw.len() < 3
            || !raw[0].is_ascii_alphabetic()
            || raw[1] != b':'
            || raw[2] != b'\\'
            || path.len() > 16_000
        {
            return Err(HistoryReadError::InvalidRoot);
        }
        if path.len() > 3 && path[3..].split('\\').any(|c| !valid_component(c)) {
            return Err(HistoryReadError::InvalidRoot);
        }
        let handle = Arc::new(open_native(None, &format!("\\??\\{path}"), true)?);
        let metadata = inspect(handle.as_ref())?;
        validate_type(metadata, true)?;
        validate_local_ntfs(handle.as_ref())?;
        #[cfg(test)]
        testing::hook(testing::Stage::Root, handle.as_ref());
        Ok(Self {
            handle,
            identity: metadata.identity,
        })
    }
    pub fn identity(&self) -> FileIdentity {
        self.identity
    }
    /// Fixed transcripts/session/snapshot metadata only. Retains every validated
    /// ancestor until the leaf observation ends, then closes all acquired handles.
    pub fn probe_snapshot_presence(&self, session_id: &str) -> SnapshotPresence {
        self.probe_presence(session_id)
            .unwrap_or_else(|error| SnapshotPresence::UnknownDenied {
                reason: error.code(),
            })
    }
    fn probe_presence(&self, session_id: &str) -> Result<SnapshotPresence, HistoryReadError> {
        if !valid_component(session_id) {
            return Err(HistoryReadError::InvalidPath);
        }
        let root_metadata = inspect(self.handle.as_ref())?;
        validate_type(root_metadata, true)?;
        if root_metadata.identity != self.identity {
            return Err(HistoryReadError::Changed);
        }
        let mut directories = vec![Arc::clone(&self.handle)];
        for (name, component, directory) in [
            ("transcripts", "transcripts", true),
            (session_id, "session", true),
            ("snapshot.json", "snapshot", false),
        ] {
            let parent = directories.last().unwrap().as_ref();
            let opened = if directory {
                open_native(Some(parent), name, true)
            } else {
                open_native_with_access(
                    Some(parent),
                    name,
                    false,
                    FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                )
            };
            let handle = match opened {
                Ok(handle) => handle,
                Err(error) if precise_absence(&error) => {
                    return Ok(SnapshotPresence::Missing { component });
                }
                Err(error) => return Err(error),
            };
            let metadata = inspect(&handle)?;
            validate_type(metadata, directory)?;
            if metadata.identity.volume_serial != self.identity.volume_serial {
                return Err(HistoryReadError::UnsupportedFilesystem);
            }
            if !directory && metadata.links != 1 {
                return Err(HistoryReadError::MultipleLinks);
            }
            #[cfg(test)]
            testing::hook(
                if directory {
                    testing::Stage::Ancestor
                } else {
                    testing::Stage::Leaf
                },
                &handle,
            );
            if directory {
                directories.push(Arc::new(handle));
            }
        }
        Ok(SnapshotPresence::Present)
    }
    pub fn open_snapshot(
        &self,
        components: &[String],
        max_bytes: usize,
    ) -> Result<HistorySnapshotLease, HistoryReadError> {
        if max_bytes == 0 || max_bytes > MAX_SNAPSHOT_BYTES {
            return Err(HistoryReadError::InvalidBudget);
        }
        if components.is_empty()
            || components.len() > MAX_COMPONENTS
            || components.iter().any(|c| !valid_component(c))
        {
            return Err(HistoryReadError::InvalidPath);
        }
        let mut directories = vec![Arc::clone(&self.handle)];
        for component in &components[..components.len() - 1] {
            let handle = Arc::new(open_native(
                Some(directories.last().unwrap().as_ref()),
                component,
                true,
            )?);
            let metadata = inspect(handle.as_ref())?;
            validate_type(metadata, true)?;
            if metadata.identity.volume_serial != self.identity.volume_serial {
                return Err(HistoryReadError::UnsupportedFilesystem);
            }
            #[cfg(test)]
            testing::hook(testing::Stage::Ancestor, handle.as_ref());
            directories.push(handle);
        }
        let leaf = open_native(
            Some(directories.last().unwrap().as_ref()),
            components.last().unwrap(),
            false,
        )
        .map_err(|error| {
            if precise_absence(&error) {
                HistoryReadError::MissingLeaf
            } else {
                error
            }
        })?;
        let before = inspect(&leaf)?;
        validate_type(before, false)?;
        if before.identity.volume_serial != self.identity.volume_serial {
            return Err(HistoryReadError::UnsupportedFilesystem);
        }
        if before.links != 1 {
            return Err(HistoryReadError::MultipleLinks);
        }
        if before.size > max_bytes as u64 {
            return Err(HistoryReadError::InvalidBudget);
        }
        #[cfg(test)]
        testing::hook(testing::Stage::Leaf, &leaf);
        // Ownership transferred once; this exact HANDLE is the only data-read source.
        let mut file = File::from(leaf);
        let mut bytes = vec![0u8; before.size as usize];
        let mut offset = 0;
        while offset < bytes.len() {
            let end = bytes.len().min(offset + 64 * 1024);
            let count = read_content(&mut file, &mut bytes[offset..end])?;
            if count == 0 {
                return Err(HistoryReadError::Changed);
            }
            offset += count;
            // Debug-only synthetic process barrier: pause while source chunks remain.
            // The release reader contains neither this hook nor its installation API.
            #[cfg(debug_assertions)]
            if offset < bytes.len() {
                DEBUG_READ_HOOK.with(|hook| {
                    if let Some(mut barrier) = hook.borrow_mut().take() {
                        barrier();
                    }
                });
            }
        }
        let after = inspect_file(&file)?;
        if before != after {
            return Err(HistoryReadError::Changed);
        }
        Ok(HistorySnapshotLease {
            bytes: bytes.into_boxed_slice(),
            identity: before.identity,
            _directories: directories,
            _leaf: file,
        })
    }
}
#[cfg(debug_assertions)]
thread_local! {
    static DEBUG_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = std::cell::RefCell::new(None);
}
/// Synthetic harness only; no filesystem access, paths, or release build API.
#[cfg(debug_assertions)]
pub fn install_debug_read_hook(hook: Box<dyn FnMut()>) {
    DEBUG_READ_HOOK.with(|slot| *slot.borrow_mut() = Some(hook));
}

fn open_native(
    parent: Option<&OwnedHandle>,
    name: &str,
    directory: bool,
) -> Result<OwnedHandle, HistoryReadError> {
    let access = if directory {
        FILE_LIST_DIRECTORY
    } else {
        FILE_READ_DATA
    } | FILE_READ_ATTRIBUTES
        | SYNCHRONIZE;
    open_native_with_access(parent, name, directory, access)
}
fn open_native_with_access(parent: Option<&OwnedHandle>, name: &str, directory: bool, access: FILE_ACCESS_RIGHTS) -> Result<OwnedHandle, HistoryReadError> {
    #[cfg(test)]
    testing::ACCESSES.with(|a| a.borrow_mut().push((directory, access.0)));
    crate::handle_fs::open_with_disposition(parent, name, Some(directory), access, windows::Wdk::Storage::FileSystem::FILE_OPEN)
        // Workspace access uses typed native causes; retain history's existing
        // public NTSTATUS contract for its callers and observed-contract tests.
        .map_err(|error| match error {
            HistoryReadError::SharingViolation => HistoryReadError::OpenFailed(0xc0000043u32 as i32),
            HistoryReadError::ReparsePoint => HistoryReadError::OpenFailed(0xc000050bu32 as i32),
            other => other,
        })
}
fn inspect_file(file: &File) -> Result<crate::handle_fs::Metadata, HistoryReadError> { inspect(file) }
#[cfg(test)]
use crate::handle_fs::raw;
#[cfg(test)]
use std::os::windows::io::FromRawHandle;
// All content reads pass this single entry. Test observer records the actual HANDLE
// identity before the OS data read; rejection cannot accidentally bypass its counter.
fn read_content(file: &mut File, bytes: &mut [u8]) -> Result<usize, HistoryReadError> {
    let metadata = inspect_file(file)?;
    validate_type(metadata, false)?;
    if metadata.links != 1 {
        return Err(HistoryReadError::MultipleLinks);
    }
    #[cfg(test)]
    testing::read(metadata.identity);
    file.read(bytes).map_err(|_| HistoryReadError::Io)
}

#[cfg(test)]
mod testing {
    use super::*;
    use std::cell::RefCell;
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(super) enum Stage {
        Root,
        Ancestor,
        Leaf,
    }
    type Hook = Box<dyn FnMut(Stage, FileIdentity)>;
    thread_local! { pub(super) static ACCESSES: RefCell<Vec<(bool, u32)>> = const { RefCell::new(Vec::new()) }; }
    thread_local! { pub(super) static HOOK: RefCell<Option<Hook>> = RefCell::new(None); pub(super) static READS: RefCell<Vec<FileIdentity>> = const { RefCell::new(Vec::new()) }; }
    pub(super) fn hook(stage: Stage, handle: &OwnedHandle) {
        HOOK.with(|h| {
            if let Some(h) = &mut *h.borrow_mut() {
                h(stage, inspect(handle).unwrap().identity);
            }
        });
    }
    pub(super) fn read(identity: FileIdentity) {
        READS.with(|r| r.borrow_mut().push(identity));
    }
}

#[cfg(test)]
mod observed_contract_tests {
    use super::*;
    use std::{cell::Cell, fs, path::PathBuf, rc::Rc};
    // Test setup only: use the existing harness's configured E isolation root.
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
            testing::READS.with(|r| r.borrow_mut().clear());
            Self(path, canonical)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            testing::HOOK.with(|h| *h.borrow_mut() = None);
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
    fn presence_requests_attributes_only_without_content_reads_or_write_rights() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("transcripts/session")).unwrap();
        fs::write(
            f.0.join("transcripts/session/snapshot.json"),
            b"synthetic invalid JSON",
        )
        .unwrap();
        let root = AuthorizedHistoryRoot::open(&f.0).unwrap();
        testing::ACCESSES.with(|a| a.borrow_mut().clear());
        assert_eq!(
            root.probe_snapshot_presence("session"),
            SnapshotPresence::Present
        );
        assert!(reads().is_empty());
        testing::ACCESSES.with(|a| {
            let access = a.borrow();
            assert_eq!(access.len(), 3);
            assert_eq!(access[2], (false, (FILE_READ_ATTRIBUTES | SYNCHRONIZE).0));
            // No WRITE_DATA/APPEND/WRITE_EA/WRITE_ATTRIBUTES/DELETE/WRITE_DAC/OWNER.
            for (_, rights) in access.iter() {
                assert_eq!(rights & 0x000d0116, 0);
            }
        });
    }
    #[test]
    fn ambiguous_native_failure_is_not_absence() {
        assert!(precise_absence(&HistoryReadError::OpenFailed(
            0xc0000034u32 as i32
        )));
        assert!(precise_absence(&HistoryReadError::OpenFailed(
            0xc000000fu32 as i32
        )));
        for code in [0xc000003au32, 0xc0000022, 0xc0000043, 0xc000050b] {
            assert!(!precise_absence(&HistoryReadError::OpenFailed(code as i32)));
        }
    }
    fn junction(link: &Path, target: &Path) {
        assert!(
            std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fn reads() -> Vec<FileIdentity> {
        testing::READS.with(|r| r.borrow().clone())
    }
    #[test]
    fn deterministic_held_root_ancestor_leaf_races_read_only_authorized_handle() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("external"), b"external").unwrap();
        // Independent registration uses metadata only; no outside data read.
        let outside_identity = inspect_file(&File::open(outside.0.join("external")).unwrap())
            .unwrap()
            .identity;
        fs::create_dir(f.0.join("nested")).unwrap();
        fs::write(f.0.join("nested/history"), b"inside").unwrap();
        let expected_identity = inspect_file(&File::open(f.0.join("nested/history")).unwrap())
            .unwrap()
            .identity;
        let root_path = f.0.clone();
        let stages = Rc::new(Cell::new(0u8));
        let recorded = Rc::clone(&stages);
        testing::HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move |stage, _identity| match stage {
                testing::Stage::Root => {
                    assert!(fs::rename(&root_path, root_path.with_extension("moved")).is_err());
                    recorded.set(recorded.get() | 1);
                }
                testing::Stage::Ancestor => {
                    assert!(fs::rename(root_path.join("nested"), root_path.join("moved")).is_err());
                    recorded.set(recorded.get() | 2);
                }
                testing::Stage::Leaf => {
                    assert!(
                        fs::rename(
                            root_path.join("nested/history"),
                            root_path.join("moved-file")
                        )
                        .is_err()
                    );
                    assert!(fs::write(root_path.join("nested/history"), b"overwrite").is_err());
                    recorded.set(recorded.get() | 4);
                }
            }))
        });
        let root = AuthorizedHistoryRoot::open(&f.0).unwrap();
        let lease = root
            .open_snapshot(&["nested".into(), "history".into()], 64)
            .unwrap();
        assert_eq!(lease.bytes(), b"inside");
        assert_eq!(stages.get(), 7);
        let observed = reads();
        assert!(!observed.is_empty());
        assert!(observed.iter().all(|id| *id == expected_identity));
        assert_eq!(
            observed
                .iter()
                .filter(|id| **id == outside_identity)
                .count(),
            0
        );
        println!(
            "actual-handle content entries={}, outside=0, deterministic stages=7",
            observed.len()
        );
    }
    #[test]
    fn new_hardlink_observed_at_leaf_barrier_is_rejected_before_content_read() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(f.0.join("history"), b"inside").unwrap();
        let source = f.0.join("history");
        let alias = outside.0.join("new-alias");
        testing::HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move |stage, _| {
                if stage == testing::Stage::Leaf {
                    fs::hard_link(&source, &alias).unwrap();
                }
            }))
        });
        let root = AuthorizedHistoryRoot::open(&f.0).unwrap();
        let result = root.open_snapshot(&["history".into()], 64);
        assert_eq!(
            reads().len(),
            0,
            "a newly observed multi-link leaf must not reach content I/O"
        );
        assert!(matches!(result, Err(HistoryReadError::MultipleLinks)));
    }
    #[test]
    fn existing_aliases_and_invalid_budget_never_enter_content_read() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("external"), b"external").unwrap();
        let outside_identity = inspect_file(&File::open(outside.0.join("external")).unwrap())
            .unwrap()
            .identity;
        junction(&f.0.join("ancestor"), &outside.0);
        junction(&f.0.join("leaf-junction"), &outside.0);
        fs::hard_link(outside.0.join("external"), f.0.join("hardlink")).unwrap();
        fs::write(f.0.join("ordinary"), b"ordinary").unwrap();
        let root = AuthorizedHistoryRoot::open(&f.0).unwrap();
        for components in [
            vec!["ancestor".into(), "external".into()],
            vec!["leaf-junction".into()],
            vec!["hardlink".into()],
            vec!["..".into(), "external".into()],
        ] {
            assert!(root.open_snapshot(&components, 64).is_err());
        }
        assert!(root.open_snapshot(&["ordinary".into()], 1).is_err());
        assert_eq!(reads().len(), 0);
        assert!(!reads().contains(&outside_identity));
        drop(root);
        fs::remove_dir(f.0.join("ancestor")).unwrap();
        fs::remove_dir(f.0.join("leaf-junction")).unwrap();
        println!("rejected alias/budget cases: content entries=0, outside=0");
    }
    #[test]
    fn maximum_bound_and_oversize_are_checked_before_data_read() {
        let f = Fixture::new();
        fs::write(f.0.join("max"), vec![65u8; MAX_SNAPSHOT_BYTES]).unwrap();
        let larger = File::create(f.0.join("too-large")).unwrap();
        larger.set_len(MAX_SNAPSHOT_BYTES as u64 + 1).unwrap();
        drop(larger);
        let root = AuthorizedHistoryRoot::open(&f.0).unwrap();
        assert!(
            root.open_snapshot(&["too-large".into()], MAX_SNAPSHOT_BYTES)
                .is_err()
        );
        assert!(reads().is_empty());
        let lease = root
            .open_snapshot(&["max".into()], MAX_SNAPSHOT_BYTES)
            .unwrap();
        assert_eq!(lease.bytes().len(), MAX_SNAPSHOT_BYTES);
        assert_eq!(reads().len(), MAX_SNAPSHOT_BYTES / (64 * 1024));
    }
    #[test]
    fn captured_bytes_remain_immutable_with_a_preexisting_writable_mapping() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::{
            Win32::System::Memory::{
                CreateFileMappingW, FILE_MAP_WRITE, MapViewOfFile, PAGE_READWRITE, UnmapViewOfFile,
            },
            core::PCWSTR,
        };
        let f = Fixture::new();
        let path = f.0.join("mapped");
        fs::write(&path, b"old!").unwrap();
        let writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(7)
            .open(&path)
            .unwrap();
        let mapping =
            unsafe { CreateFileMappingW(raw(&writer), None, PAGE_READWRITE, 0, 4, PCWSTR::null()) }
                .unwrap();
        let mapping = unsafe { OwnedHandle::from_raw_handle(mapping.0) };
        let view = unsafe { MapViewOfFile(raw(&mapping), FILE_MAP_WRITE, 0, 0, 4) };
        assert!(!view.Value.is_null());
        drop(writer);
        let root = AuthorizedHistoryRoot::open(&f.0).unwrap();
        let lease = root.open_snapshot(&["mapped".into()], 4);
        match lease {
            Ok(lease) => {
                let captured = lease.bytes().to_vec();
                unsafe {
                    std::ptr::copy_nonoverlapping(b"new!".as_ptr(), view.Value.cast::<u8>(), 4);
                }
                assert_eq!(lease.bytes(), captured);
                println!(
                    "preexisting mapped writer remained possible; captured bytes stayed immutable; no atomic-source claim"
                );
            }
            Err(error) => {
                assert!(matches!(
                    error,
                    HistoryReadError::OpenFailed(_) | HistoryReadError::Changed
                ));
                println!("preexisting mapped writer rejected: {}", error.code());
            }
        }
        unsafe { UnmapViewOfFile(view) }.unwrap();
        drop(mapping);
    }
}
