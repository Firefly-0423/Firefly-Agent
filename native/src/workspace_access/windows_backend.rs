use super::*;
use crate::handle_fs::{self, HandleError, Metadata, inspect, raw, valid_component, validate_local_ntfs, validate_type};
use std::{fs::File, io::{Read, Seek, SeekFrom, Write}, os::windows::io::{AsRawHandle, OwnedHandle}, sync::Arc};
use windows::{
    Wdk::Storage::FileSystem::{FILE_CREATE, FILE_OPEN, FileNamesInformation, NtQueryDirectoryFile, NTCREATEFILE_CREATE_DISPOSITION},
    Win32::Storage::FileSystem::{FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_DIRECTORY, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_WRITE_DATA, SYNCHRONIZE, GetFinalPathNameByHandleW, VOLUME_NAME_NONE},
    Win32::System::IO::IO_STATUS_BLOCK,
};

impl From<HandleError> for WorkspaceError {
    fn from(error: HandleError) -> Self {
        match error {
            HandleError::OpenFailed(code) if [0xc000000fu32 as i32, 0xc0000034u32 as i32].contains(&code) => Self::Missing,
            HandleError::ReparsePoint => Self::ReparsePoint,
            HandleError::MultipleLinks => Self::HardLink,
            HandleError::SharingViolation => Self::SharingViolation,
            HandleError::UnsupportedFilesystem => Self::UnsupportedFilesystem,
            HandleError::Io | HandleError::OpenFailed(_) => Self::Io,
            HandleError::MissingLeaf => Self::Missing,
            _ => Self::Boundary,
        }
    }
}
fn identity(m: Metadata) -> Identity { Identity { device_id: OpaqueId(m.identity.volume_serial as u128), file_id: OpaqueId(m.identity.file_index as u128) } }
fn kind(m: Metadata) -> Kind { if m.attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0 { Kind::Directory } else { Kind::File } }
fn components(names: &[String], allow_empty: bool) -> Result<()> {
    if (!allow_empty && names.is_empty()) || names.len() > MAX_COMPONENTS || names.iter().any(|s| !valid_component(s)) {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(())
}
fn open(parent: Option<&OwnedHandle>, name: &str, directory: Option<bool>, access: FILE_ACCESS_RIGHTS, disposition: NTCREATEFILE_CREATE_DISPOSITION) -> Result<OwnedHandle> {
    handle_fs::open_with_disposition(parent, name, directory, access | FILE_READ_ATTRIBUTES | SYNCHRONIZE, disposition).map_err(Into::into)
}
fn checked(handle: &impl AsRawHandle, volume: u32, expected: Option<bool>) -> Result<Metadata> {
    let m = inspect(handle)?;
    let directory = kind(m) == Kind::Directory;
    validate_type(m, expected.unwrap_or(directory))?;
    if m.identity.volume_serial != volume { return Err(WorkspaceError::Boundary); }
    if !directory && m.links != 1 { return Err(WorkspaceError::HardLink); }
    Ok(m)
}
fn normalized_name(handle: &impl AsRawHandle) -> Result<String> {
    let mut wide = vec![0u16; 32768];
    // VOLUME_NAME_NONE avoids a DOS-device namespace lookup. The normalized
    // filesystem name (including long names/casing) comes from this exact handle.
    // https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
    let length = unsafe { GetFinalPathNameByHandleW(raw(handle), &mut wide, VOLUME_NAME_NONE) } as usize;
    if length == 0 || length >= wide.len() { return Err(WorkspaceError::Boundary); }
    let name = String::from_utf16(&wide[..length]).map_err(|_| WorkspaceError::Boundary)?;
    if !name.starts_with('\\') || name.contains('\0') { return Err(WorkspaceError::Boundary); }
    Ok(name)
}
fn canonical_name(handle: &impl AsRawHandle, drive: char) -> Result<String> { Ok(format!("{drive}:{}", normalized_name(handle)?)) }
fn observation(handle: &impl AsRawHandle, volume: u32, drive: char) -> Result<Snapshot> {
    let m = checked(handle, volume, None)?;
    Ok(Snapshot { exists: true, kind: kind(m), size: m.size, identity: Some(identity(m)), canonical_path: Some(canonical_name(handle, drive)?), bytes: None })
}
fn file_snapshot(file: &mut File, volume: u32, drive: char, max_bytes: usize) -> Result<Snapshot> {
    let before = checked(file, volume, Some(false))?;
    let mut snap = observation(file, volume, drive)?;
    if before.size > max_bytes as u64 { return Ok(snap); }
    file.seek(SeekFrom::Start(0)).map_err(|_| WorkspaceError::Io)?;
    let mut bytes = vec![0; before.size as usize];
    for chunk in bytes.chunks_mut(64 * 1024) {
        checked(file, volume, Some(false))?;
        #[cfg(test)] testing::io("read", file);
        file.read_exact(chunk).map_err(|_| WorkspaceError::Io)?;
    }
    if checked(file, volume, Some(false))? != before { return Err(WorkspaceError::Boundary); }
    snap.bytes = Some(bytes);
    Ok(snap)
}

pub struct WindowsRoot {
    // Authorized root and every traversed workspace ancestor remain held.
    directories: Vec<Arc<OwnedHandle>>,
    volume: u32,
    drive: char,
}
impl WindowsRoot {
    fn parent(&self) -> &OwnedHandle { self.directories.last().unwrap().as_ref() }
    fn walk(&self, names: &[String]) -> Result<Vec<Arc<OwnedHandle>>> {
        let mut dirs = self.directories.clone();
        for name in names {
            let h = open(Some(dirs.last().unwrap()), name, Some(true), FILE_LIST_DIRECTORY, FILE_OPEN)?;
            checked(&h, self.volume, Some(true))?;
            dirs.push(Arc::new(h));
            #[cfg(test)] testing::hook(testing::Stage::Ancestor);
        }
        Ok(dirs)
    }
    fn entry(&self, names: &[String], access: FILE_ACCESS_RIGHTS) -> Result<(Vec<Arc<OwnedHandle>>, OwnedHandle)> {
        components(names, false)?;
        let dirs = self.walk(&names[..names.len()-1])?;
        let leaf = open(Some(dirs.last().unwrap()), names.last().unwrap(), None, access, FILE_OPEN)?;
        checked(&leaf, self.volume, None)?;
        #[cfg(test)] testing::hook(testing::Stage::Leaf);
        Ok((dirs, leaf))
    }
}
impl WorkspaceBackend for WindowsRoot {
    type File = WindowsFile;
    fn open(root: &Path) -> Result<Self> {
        let text = root.to_str().ok_or(WorkspaceError::InvalidPath)?;
        // Accept only local drive paths (including the standard long-path prefix).
        let text = text.strip_prefix("\\\\?\\").unwrap_or(text);
        let b = text.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' || text.encode_utf16().count() > 16_000 {
            return Err(WorkspaceError::InvalidPath);
        }
        let suffix = text[3..].trim_end_matches('\\');
        let names: Vec<String> = if suffix.is_empty() { vec![] } else { suffix.split('\\').map(str::to_owned).collect() };
        components(&names, true)?;
        // As in history_read, OBJ_DONT_REPARSE applies to the entire absolute
        // root acquisition, including its ancestors. Subsequent opens are relative.
        let root_handle = Arc::new(open(None, &format!("\\??\\{text}"), Some(true), FILE_LIST_DIRECTORY, FILE_OPEN)?);
        let m = inspect(root_handle.as_ref())?;
        validate_type(m, true)?;
        validate_local_ntfs(root_handle.as_ref())?;
        // Reject SUBST/short-root aliases rather than inventing a drive mapping.
        // Case differences are harmless on the case-insensitive NT opens above.
        let root_name = normalized_name(root_handle.as_ref())?;
        let requested_name = if text.len() == 3 { "\\" } else { text[2..].trim_end_matches('\\') };
        if root_name.to_uppercase() != requested_name.to_uppercase() { return Err(WorkspaceError::InvalidPath); }
        let root = Self { directories: vec![root_handle], volume: m.identity.volume_serial, drive: (b[0] as char).to_ascii_uppercase() };
        #[cfg(test)] testing::hook(testing::Stage::Root);
        Ok(root)
    }
    fn read(&self, names: &[String], max_bytes: usize) -> Result<Snapshot> {
        if max_bytes == 0 || max_bytes > MAX_BYTES { return Err(WorkspaceError::Budget); }
        components(names, true)?;
        if names.is_empty() { return observation(self.parent(), self.volume, self.drive); }
        let (_dirs, leaf) = match self.entry(names, FILE_READ_DATA) { Ok(v) => v, Err(WorkspaceError::Missing) => return Ok(Snapshot::missing()), Err(e) => return Err(e) };
        let mut file = File::from(leaf);
        let snap = observation(&file, self.volume, self.drive)?;
        if snap.kind != Kind::File { return Ok(snap); }
        file_snapshot(&mut file, self.volume, self.drive, max_bytes)
    }
    fn stat(&self, names: &[String]) -> Result<Snapshot> {
        components(names, true)?;
        if names.is_empty() { return observation(self.parent(), self.volume, self.drive); }
        let (_dirs, leaf) = match self.entry(names, FILE_READ_ATTRIBUTES) { Ok(v) => v, Err(WorkspaceError::Missing) => return Ok(Snapshot::missing()), Err(e) => return Err(e) };
        observation(&leaf, self.volume, self.drive)
    }
    fn list(&self, names: &[String]) -> Result<Vec<Entry>> {
        components(names, true)?;
        let dirs = self.walk(names)?;
        let directory = dirs.last().unwrap().as_ref();
        checked(directory, self.volume, Some(true))?;
        #[cfg(test)] testing::hook(testing::Stage::Leaf);
        let mut entries = Vec::new();
        // Aligned storage, bounded records; names are never interpreted as paths.
        let mut storage = vec![0u64; 8192];
        let mut restart = true;
        loop {
            checked(directory, self.volume, Some(true))?;
            #[cfg(test)] testing::io("list", directory);
            let mut status = IO_STATUS_BLOCK::default();
            // Source: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntquerydirectoryfile
            let result = unsafe { NtQueryDirectoryFile(raw(directory), None, None, None, &mut status,
                storage.as_mut_ptr().cast(), (storage.len()*8) as u32, FileNamesInformation, false, None, restart) };
            restart = false;
            if result.0 == 0x80000006u32 as i32 { break; } // STATUS_NO_MORE_FILES
            if result.0 != 0 { return Err(WorkspaceError::Boundary); }
            let length = status.Information;
            if length == 0 || length > storage.len()*8 { return Err(WorkspaceError::Boundary); }
            // SAFETY: the NT call initialized precisely Information bytes in this buffer.
            let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), length) };
            let mut offset = 0;
            loop {
                let record = bytes.get(offset..).ok_or(WorkspaceError::Boundary)?;
                if record.len() < 12 { return Err(WorkspaceError::Boundary); }
                let next = u32::from_le_bytes(record[0..4].try_into().unwrap()) as usize;
                let size = u32::from_le_bytes(record[8..12].try_into().unwrap()) as usize;
                if size == 0 || size % 2 != 0 { return Err(WorkspaceError::Boundary); }
                let encoded = record.get(12..12+size).ok_or(WorkspaceError::Boundary)?;
                let wide: Vec<u16> = encoded.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                let name = String::from_utf16(&wide).map_err(|_| WorkspaceError::InvalidPath)?;
                if name != "." && name != ".." {
                    if !valid_component(&name) || entries.len() >= MAX_ENTRIES { return Err(WorkspaceError::Budget); }
                    // Child metadata is opened RELATIVE to the same enumerated directory.
                    // Reparse entries and multi-link files fail closed instead of being followed.
                    let child = open(Some(directory), &name, None, FILE_READ_ATTRIBUTES, FILE_OPEN)?;
                    let m = checked(&child, self.volume, None)?;
                    entries.push(Entry { name, kind: kind(m), size: m.size, identity: identity(m) });
                }
                if next == 0 { break; }
                if next < 12+size || next % 4 != 0 || offset+next >= length { return Err(WorkspaceError::Boundary); }
                offset += next;
            }
        }
        Ok(entries)
    }
    fn prepare_write(&self, names: &[String], create_parents: bool) -> Result<WindowsFile> {
        components(names, false)?;
        let mut dirs = self.directories.clone();
        let mut pending = Vec::new();
        for (index, name) in names[..names.len()-1].iter().enumerate() {
            let h = match open(Some(dirs.last().unwrap()), name, Some(true), FILE_LIST_DIRECTORY, FILE_OPEN) {
                Ok(h) => h,
                Err(WorkspaceError::Missing) if create_parents => { pending.extend_from_slice(&names[index..names.len()-1]); break; },
                Err(e) => return Err(e),
            };
            checked(&h, self.volume, Some(true))?;
            dirs.push(Arc::new(h));
            #[cfg(test)] testing::hook(testing::Stage::Ancestor);
        }
        let leaf_name = names.last().unwrap().clone();
        let leaf = if pending.is_empty() {
            match open(Some(dirs.last().unwrap()), &leaf_name, Some(false), FILE_READ_DATA | FILE_WRITE_DATA, FILE_OPEN) {
                Ok(h) => { checked(&h, self.volume, Some(false))?; Some(File::from(h)) },
                Err(WorkspaceError::Missing) => None,
                Err(e) => return Err(e),
            }
        } else { None };
        #[cfg(test)] testing::hook(testing::Stage::Leaf);
        let mut file = WindowsFile { directories: dirs, volume: self.volume, drive: self.drive, pending, leaf_name, file: leaf, before: Snapshot::missing(), committed: false };
        if let Some(leaf) = &mut file.file {
            file.before = file_snapshot(leaf, self.volume, self.drive, MAX_BYTES)?;
            if file.before.bytes.is_none() { return Err(WorkspaceError::Budget); }
        } else {
            let parent_name = canonical_name(file.directories.last().unwrap().as_ref(), self.drive)?;
            let suffix = file.pending.iter().chain(std::iter::once(&file.leaf_name)).cloned().collect::<Vec<_>>().join("\\");
            file.before.canonical_path = Some(format!("{}\\{suffix}", parent_name.trim_end_matches('\\')));
        }
        Ok(file)
    }
}
pub struct WindowsFile {
    directories: Vec<Arc<OwnedHandle>>,
    volume: u32,
    drive: char,
    pending: Vec<String>,
    leaf_name: String,
    file: Option<File>,
    before: Snapshot,
    committed: bool,
}
impl WorkspaceFile for WindowsFile {
    fn before(&self) -> &Snapshot { &self.before }
    fn commit(&mut self, mode: WriteMode, bytes: &[u8]) -> Result<Snapshot> {
        let size = if matches!(mode, WriteMode::Append) { self.before.size } else { 0 };
        if self.committed || size.saturating_add(bytes.len() as u64) > MAX_BYTES as u64 { return Err(WorkspaceError::Budget); }
        self.committed = true;
        for name in &self.pending {
            let parent = self.directories.last().unwrap().as_ref();
            checked(parent, self.volume, Some(true))?;
            #[cfg(test)] testing::hook(testing::Stage::ParentCreate);
            // FILE_CREATE is exclusive: an attacker racing a new entry wins only a rejection.
            let child = open(Some(parent), name, Some(true), FILE_LIST_DIRECTORY, FILE_CREATE)?;
            checked(&child, self.volume, Some(true))?;
            self.directories.push(Arc::new(child));
        }
        if self.file.is_none() {
            let parent = self.directories.last().unwrap().as_ref();
            checked(parent, self.volume, Some(true))?;
            #[cfg(test)] testing::hook(testing::Stage::ParentCreate);
            let leaf = open(Some(parent), &self.leaf_name, Some(false), FILE_READ_DATA | FILE_WRITE_DATA, FILE_CREATE)?;
            checked(&leaf, self.volume, Some(false))?;
            self.file = Some(File::from(leaf));
        }
        let file = self.file.as_mut().unwrap();
        #[cfg(test)] testing::hook(testing::Stage::BeforeIo);
        checked(file, self.volume, Some(false))?;
        // No overwrite/supersede disposition. Truncation occurs ONLY after handle verification.
        #[cfg(test)] testing::io("write", file);
        match mode {
            WriteMode::Replace => { file.seek(SeekFrom::Start(0)).map_err(|_| WorkspaceError::Io)?; },
            WriteMode::Append => { file.seek(SeekFrom::End(0)).map_err(|_| WorkspaceError::Io)?; },
        }
        #[cfg(test)]
        testing::write(file, bytes).map_err(|_| WorkspaceError::Io)?;
        #[cfg(not(test))]
        file.write_all(bytes).map_err(|_| WorkspaceError::Io)?;
        // Same validated handle/identity/ACLs. This is not atomic: an interrupted
        // write can leave a new prefix mixed with the old, untruncated tail.
        if matches!(mode, WriteMode::Replace) { file.set_len(bytes.len() as u64).map_err(|_| WorkspaceError::Io)?; }
        file.sync_all().map_err(|_| WorkspaceError::Io)?;
        let after = file_snapshot(file, self.volume, self.drive, MAX_BYTES)?;
        if after.bytes.is_none() { return Err(WorkspaceError::Budget); }
        Ok(after)
    }
}

#[cfg(test)]
mod testing {
    use super::*;
    use std::cell::RefCell;
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Stage { Root, Ancestor, Leaf, ParentCreate, BeforeIo }
    type Hook = Box<dyn FnMut(Stage)>;
    thread_local! {
        pub(super) static WRITE_LIMIT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
        pub(super) static HOOK: RefCell<Option<Hook>> = RefCell::new(None);
        pub(super) static IOS: RefCell<Vec<(&'static str, Identity)>> = const { RefCell::new(Vec::new()) };
    }
    pub(super) fn write(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
        match WRITE_LIMIT.with(|v| v.take()) {
            Some(limit) => { file.write_all(&bytes[..bytes.len().min(limit)])?; Err(std::io::Error::other("injected partial write failure")) },
            None => file.write_all(bytes),
        }
    }
    pub(super) fn hook(stage: Stage) { HOOK.with(|slot| { if let Some(h) = slot.borrow_mut().as_mut() { h(stage); } }); }
    pub(super) fn io(op: &'static str, handle: &impl AsRawHandle) { IOS.with(|v| v.borrow_mut().push((op, identity(inspect(handle).unwrap())))); }
}
#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
