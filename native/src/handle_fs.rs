//! Shared NT handle primitives extracted from history_read. History policy stays in that module.
use std::{
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_CREATE, FILE_OPEN_IF, FILE_SYNCHRONOUS_IO_NONALERT,
            FileFsDeviceInformation, NtCreateFile, NtQueryVolumeInformationFile,
            NTCREATEFILE_CREATE_DISPOSITION, NTCREATEFILE_CREATE_OPTIONS,
        },
        System::SystemServices::{
            FILE_FS_DEVICE_INFORMATION, FILE_REMOTE_DEVICE, FILE_REMOTE_DEVICE_VSMB,
        },
    },
    Win32::{
        Foundation::{HANDLE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING},
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_DIRECTORY,
            FILE_DEVICE_DISK, FILE_FLAGS_AND_ATTRIBUTES,
            FILE_SHARE_READ, FILE_TYPE_DISK, GetFileInformationByHandle,
            GetFileType, GetVolumeInformationByHandleW,
        },
        System::IO::IO_STATUS_BLOCK,
    },
    core::PWSTR,
};

#[derive(Debug, thiserror::Error)]
pub enum HandleError {
    #[error("history-invalid-root")]
    InvalidRoot,
    #[error("history-invalid-path")]
    InvalidPath,
    #[error("history-invalid-budget")]
    InvalidBudget,
    #[error("history-unsupported-filesystem")]
    UnsupportedFilesystem,
    #[error("history-unsafe-attributes")]
    UnsafeAttributes,
    #[error("history-multiple-links")]
    MultipleLinks,
    #[error("history-source-changed")]
    Changed,
    #[error("history-leaf-missing")]
    MissingLeaf,
    #[error("history-native-open-failed: reparse point")]
    ReparsePoint,
    #[error("history-native-open-failed: sharing violation")]
    SharingViolation,
    #[error("history-native-open-failed: NTSTATUS {0:#010x}")]
    OpenFailed(i32),
    #[error("history-native-io-failed")]
    Io,
}
impl HandleError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRoot => "history-invalid-root",
            Self::InvalidPath => "history-invalid-path",
            Self::InvalidBudget => "history-invalid-budget",
            Self::UnsupportedFilesystem => "history-unsupported-filesystem",
            Self::UnsafeAttributes => "history-unsafe-attributes",
            Self::MultipleLinks => "history-multiple-links",
            Self::Changed => "history-source-changed",
            Self::MissingLeaf => "history-leaf-missing",
            Self::ReparsePoint | Self::SharingViolation => "history-native-open-failed",
            Self::OpenFailed(_) => "history-native-open-failed",
            Self::Io => "history-native-io-failed",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub volume_serial: u32,
    #[serde(serialize_with = "serialize_file_index")]
    pub file_index: u64,
}
fn serialize_file_index<S: serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&format!("{value:016x}"))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub(crate) identity: FileIdentity,
    pub(crate) size: u64,
    pub(crate) last_write: u64,
    pub(crate) attrs: u32,
    pub(crate) links: u32,
}
pub(crate) fn valid_component(component: &str) -> bool {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.encode_utf16().count() > 255
        || component.ends_with(['.', ' '])
        || component
            .chars()
            .any(|c| c <= '\u{1f}' || "\\/:*?\"<>|".contains(c))
    {
        return false;
    }
    let stem = component.split('.').next().unwrap().to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) {
        return false;
    }
    if let Some(suffix) = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
    {
        if ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix) {
            return false;
        }
    }
    true
}
pub(crate) fn raw(handle: &impl AsRawHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}
pub(crate) fn open_with_disposition(
    parent: Option<&OwnedHandle>,
    name: &str,
    directory: Option<bool>,
    access: FILE_ACCESS_RIGHTS,
    disposition: NTCREATEFILE_CREATE_DISPOSITION,
) -> Result<OwnedHandle, HandleError> {
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let byte_length = wide
        .len()
        .checked_mul(2)
        .and_then(|n| u16::try_from(n).ok())
        .ok_or(HandleError::InvalidPath)?;
    let unicode = UNICODE_STRING {
        Length: byte_length,
        MaximumLength: byte_length,
        Buffer: PWSTR(wide.as_mut_ptr()),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.map(raw).unwrap_or_default(),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let options = match directory { Some(true) => FILE_DIRECTORY_FILE, Some(false) => FILE_NON_DIRECTORY_FILE, None => NTCREATEFILE_CREATE_OPTIONS(0) } | FILE_SYNCHRONOUS_IO_NONALERT;
    let mut output = HANDLE::default();
    let mut status = IO_STATUS_BLOCK::default();
    // RootDirectory + OBJ_DONT_REPARSE: never follow a reparse point. Only FILE_OPEN/FILE_CREATE/FILE_OPEN_IF are accepted.
    if ![FILE_OPEN, FILE_CREATE, FILE_OPEN_IF].contains(&disposition) { return Err(HandleError::InvalidPath); }
    let result = unsafe {
        NtCreateFile(
            &mut output,
            access,
            &attributes,
            &mut status,
            None,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            FILE_SHARE_READ,
            disposition,
            options,
            None,
            0,
        )
    };
    if result.0 != 0 || output.is_invalid() {
        if !output.is_invalid() {
            drop(unsafe { OwnedHandle::from_raw_handle(output.0) });
        }
        return Err(match result.0 as u32 {
            0xc0000043 => HandleError::SharingViolation, // STATUS_SHARING_VIOLATION
            0xc000050b => HandleError::ReparsePoint, // STATUS_REPARSE_POINT_ENCOUNTERED
            _ => HandleError::OpenFailed(result.0),
        });
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(output.0) })
}
pub(crate) fn inspect(handle: &impl AsRawHandle) -> Result<Metadata, HandleError> {
    let handle = raw(handle);
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return Err(HandleError::UnsupportedFilesystem);
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle, &mut info) }.map_err(|_| HandleError::Io)?;
    Ok(Metadata {
        identity: FileIdentity {
            volume_serial: info.dwVolumeSerialNumber,
            file_index: (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64,
        },
        size: (info.nFileSizeHigh as u64) << 32 | info.nFileSizeLow as u64,
        last_write: (info.ftLastWriteTime.dwHighDateTime as u64) << 32
            | info.ftLastWriteTime.dwLowDateTime as u64,
        attrs: info.dwFileAttributes,
        links: info.nNumberOfLinks,
    })
}
pub(crate) fn validate_type(metadata: Metadata, directory: bool) -> Result<(), HandleError> {
    // Readonly/hidden/system/archive/normal/not-content-indexed plus expected directory.
    const ALLOWED: u32 = 0x1 | 0x2 | 0x4 | 0x20 | 0x80 | 0x2000;
    let dir = FILE_ATTRIBUTE_DIRECTORY.0;
    if (metadata.attrs & dir != 0) != directory
        || metadata.attrs & !(ALLOWED | if directory { dir } else { 0 }) != 0
    {
        return Err(HandleError::UnsafeAttributes);
    }
    Ok(())
}
pub(crate) fn validate_local_ntfs(handle: &OwnedHandle) -> Result<(), HandleError> {
    let mut device = FILE_FS_DEVICE_INFORMATION::default();
    let mut status = IO_STATUS_BLOCK::default();
    let result = unsafe {
        NtQueryVolumeInformationFile(
            raw(handle),
            &mut status,
            (&mut device as *mut FILE_FS_DEVICE_INFORMATION).cast(),
            size_of::<FILE_FS_DEVICE_INFORMATION>() as u32,
            FileFsDeviceInformation,
        )
    };
    if result.0 != 0
        || device.DeviceType != FILE_DEVICE_DISK.0
        || device.Characteristics & (FILE_REMOTE_DEVICE | FILE_REMOTE_DEVICE_VSMB) != 0
    {
        return Err(HandleError::UnsupportedFilesystem);
    }
    let mut name = [0u16; 32];
    unsafe { GetVolumeInformationByHandleW(raw(handle), None, None, None, None, Some(&mut name)) }
        .map_err(|_| HandleError::UnsupportedFilesystem)?;
    let end = name
        .iter()
        .position(|c| *c == 0)
        .ok_or(HandleError::UnsupportedFilesystem)?;
    if &name[..end] != ['N' as u16, 'T' as u16, 'F' as u16, 'S' as u16] {
        return Err(HandleError::UnsupportedFilesystem);
    }
    Ok(())
}
