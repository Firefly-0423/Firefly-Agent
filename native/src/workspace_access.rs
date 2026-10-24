//! Workspace operations have no path-based I/O after root acquisition.
//! Backends own handles and snapshots; the private JSON protocol is platform independent.
use std::path::Path;
use serde::Serialize;

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_COMPONENTS: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("workspace-unsupported-platform")]
    UnsupportedPlatform,
    #[error("workspace-invalid-path")]
    InvalidPath,
    #[error("workspace-boundary")]
    Boundary,
    #[error("workspace-boundary")]
    ReparsePoint,
    #[error("workspace-boundary")]
    HardLink,
    #[error("workspace-busy")]
    SharingViolation,
    #[error("workspace-boundary")]
    UnsupportedFilesystem,
    #[error("workspace-missing")]
    Missing,
    #[error("workspace-budget")]
    Budget,
    #[error("workspace-io")]
    Io,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorReason {
    ReparsePoint, HardLink, OutsideRoot, SharingViolation, Missing, Io,
    InvalidPath, UnsupportedFilesystem, UnsupportedPlatform, Budget, Protocol,
}
impl WorkspaceError {
    pub fn reason(&self) -> ErrorReason {
        match self {
            Self::ReparsePoint => ErrorReason::ReparsePoint,
            Self::HardLink => ErrorReason::HardLink,
            Self::Boundary => ErrorReason::OutsideRoot,
            Self::SharingViolation => ErrorReason::SharingViolation,
            Self::Missing => ErrorReason::Missing,
            Self::Io => ErrorReason::Io,
            Self::InvalidPath => ErrorReason::InvalidPath,
            Self::UnsupportedFilesystem => ErrorReason::UnsupportedFilesystem,
            Self::UnsupportedPlatform => ErrorReason::UnsupportedPlatform,
            Self::Budget => ErrorReason::Budget,
        }
    }
}
pub type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub device_id: OpaqueId,
    pub file_id: OpaqueId,
}
// Opaque 128-bit strings preserve Windows IDs and future Unix dev/ino values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpaqueId(pub u128);
impl Serialize for OpaqueId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:032x}", self.0))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind { File, Directory, Missing }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub exists: bool,
    pub kind: Kind,
    pub size: u64,
    pub identity: Option<Identity>,
    pub canonical_path: Option<String>,
    #[serde(rename = "bytesHex", serialize_with = "serialize_bytes")]
    pub bytes: Option<Vec<u8>>,
}
impl Snapshot {
    pub fn missing() -> Self {
        Self { exists: false, kind: Kind::Missing, size: 0, identity: None, canonical_path: None, bytes: None }
    }
}
fn serialize_bytes<S: serde::Serializer>(bytes: &Option<Vec<u8>>, s: S) -> std::result::Result<S::Ok, S::Error> {
    match bytes {
        Some(bytes) => s.serialize_some(&encode_hex(bytes)),
        None => s.serialize_none(),
    }
}
pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for b in bytes { text.push(HEX[(b >> 4) as usize] as char); text.push(HEX[(b & 15) as usize] as char); }
    text
}
pub fn decode_hex(text: &str) -> Result<Vec<u8>> {
    if text.len() > MAX_BYTES * 2 || !text.len().is_multiple_of(2) { return Err(WorkspaceError::Budget); }
    fn digit(b: u8) -> Result<u8> {
        match b { b'0'..=b'9' => Ok(b - b'0'), b'a'..=b'f' => Ok(b - b'a' + 10), _ => Err(WorkspaceError::InvalidPath) }
    }
    text.as_bytes().chunks_exact(2).map(|b| Ok(digit(b[0])? * 16 + digit(b[1])?)).collect()
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry { pub name: String, pub kind: Kind, pub size: u64, pub identity: Identity }
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteMode { Replace, Append }

/// A future Unix implementation can retain OwnedFd ancestors, use openat with
/// O_NOFOLLOW|O_DIRECTORY, fstat/fstatat, mkdirat and handle enumeration. It must
/// satisfy the same lease/commit contract; there is deliberately no Unix I/O here.
pub trait WorkspaceBackend: Sized {
    type File: WorkspaceFile;
    fn open(root: &Path) -> Result<Self>;
    fn read(&self, components: &[String], max_bytes: usize) -> Result<Snapshot>;
    fn stat(&self, components: &[String]) -> Result<Snapshot>;
    fn list(&self, components: &[String]) -> Result<Vec<Entry>>;
    fn prepare_write(&self, components: &[String], create_parents: bool) -> Result<Self::File>;
}
pub trait WorkspaceFile {
    fn before(&self) -> &Snapshot;
    fn commit(&mut self, mode: WriteMode, bytes: &[u8]) -> Result<Snapshot>;
}
#[cfg(windows)]
mod windows_backend;
#[cfg(windows)]
pub use windows_backend::WindowsRoot as WorkspaceRoot;
#[cfg(not(windows))]
mod unsupported {
    use super::*;
    pub struct Root;
    pub struct File;
    impl WorkspaceBackend for Root {
        type File = File;
        fn open(_: &Path) -> Result<Self> { Err(WorkspaceError::UnsupportedPlatform) }
        fn read(&self, _: &[String], _: usize) -> Result<Snapshot> { Err(WorkspaceError::UnsupportedPlatform) }
        fn stat(&self, _: &[String]) -> Result<Snapshot> { Err(WorkspaceError::UnsupportedPlatform) }
        fn list(&self, _: &[String]) -> Result<Vec<Entry>> { Err(WorkspaceError::UnsupportedPlatform) }
        fn prepare_write(&self, _: &[String], _: bool) -> Result<File> { Err(WorkspaceError::UnsupportedPlatform) }
    }
    impl WorkspaceFile for File {
        fn before(&self) -> &Snapshot { unreachable!("unsupported root cannot produce a file lease") }
        fn commit(&mut self, _: WriteMode, _: &[u8]) -> Result<Snapshot> { Err(WorkspaceError::UnsupportedPlatform) }
    }
}
#[cfg(not(windows))]
pub use unsupported::Root as WorkspaceRoot;
