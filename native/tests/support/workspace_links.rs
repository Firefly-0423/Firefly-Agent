//! Test fixtures only. Never included by a production module or binary.
use std::{fs, io, mem::offset_of, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, path::Path};
use windows::{Wdk::Storage::FileSystem::{FILE_LINK_INFORMATION, FileLinkInformation, NtSetInformationFile}, Win32::{Foundation::HANDLE, System::IO::{DeviceIoControl, IO_STATUS_BLOCK}}};

/// Apply a junction to an owned empty directory, without a DOS realpath lookup.
pub fn set_junction(handle: &impl AsRawHandle, target: &Path) -> io::Result<()> {
    let target = target.to_str().expect("UTF-16 test path").trim_start_matches("\\\\?\\");
    let substitute: Vec<u16> = format!("\\??\\{target}").encode_utf16().collect();
    let print: Vec<u16> = target.encode_utf16().collect();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0xa0000003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
    let data_length = 8 + (substitute.len()+1+print.len()+1)*2;
    bytes.extend_from_slice(&(data_length as u16).to_le_bytes()); bytes.extend_from_slice(&0u16.to_le_bytes());
    for value in [0, substitute.len()*2, (substitute.len()+1)*2, print.len()*2] { bytes.extend_from_slice(&(value as u16).to_le_bytes()); }
    for wide in substitute.into_iter().chain([0]).chain(print).chain([0]) { bytes.extend_from_slice(&wide.to_le_bytes()); }
    // Layout/API: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer
    let mut returned = 0u32;
    unsafe { DeviceIoControl(HANDLE(handle.as_raw_handle()), 0x000900a4, Some(bytes.as_ptr().cast()), bytes.len() as u32, None, 0, Some(&mut returned), None) }
        .map_err(|e| io::Error::from_raw_os_error((e.code().0 & 0xffff) as i32))
}
pub fn junction(link: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir(link)?;
    let dir = fs::OpenOptions::new().access_mode(0x00000002 | 0x00000080 | 0x00100000).share_mode(7).custom_flags(0x02000000 | 0x00200000).open(link)?;
    set_junction(&dir, target)
}
pub fn hard_link(source: &Path, destination: &Path) -> io::Result<()> {
    let file = fs::OpenOptions::new().read(true).write(true).share_mode(7).open(source)?;
    let name: Vec<u16> = format!("\\??\\{}", destination.to_str().unwrap().trim_start_matches("\\\\?\\")).encode_utf16().collect();
    let offset = offset_of!(FILE_LINK_INFORMATION, FileName);
    let length = offset + name.len()*2;
    let mut words = vec![0u64; length.div_ceil(8)];
    let info = words.as_mut_ptr().cast::<FILE_LINK_INFORMATION>();
    // Aligned storage includes the complete flexible FileName array. Zero flags
    // mean no replacement, no POSIX semantics and no bypass-access-check class.
    unsafe {
        (*info).FileNameLength = (name.len()*2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), words.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(), name.len());
    }
    let mut status = IO_STATUS_BLOCK::default();
    let result = unsafe { NtSetInformationFile(HANDLE(file.as_raw_handle()), &mut status, info.cast(), length as u32, FileLinkInformation) };
    if result.0 == 0 { Ok(()) } else { Err(io::Error::other(format!("test hard-link NTSTATUS {:#010x}", result.0))) }
}
