use crate::{ipc::MessageTarget, WM_APP_SHUTDOWN};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE},
};

pub fn start(parent_pid: u32, target: MessageTarget) {
    // Acquire before returning to the caller that publishes Ready.
    let owned_parent = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) } {
        Err(open_failure) => {
            eprintln!("parent watcher could not open PID {parent_pid}: {open_failure}");
            return;
        }
        // SAFETY: The successful call transfers one process handle to us.
        Ok(opened) => unsafe { OwnedHandle::from_raw_handle(opened.0) },
    };
    std::thread::Builder::new()
        .name(String::from("firefly-parent-watch"))
        .spawn(move || watch_parent(owned_parent, target))
        .expect("failed to start parent watcher");
}

fn watch_parent(owned_parent: OwnedHandle, destination: MessageTarget) {
    // SAFETY: owned_parent keeps the borrowed handle alive throughout the wait.
    let status = unsafe { WaitForSingleObject(HANDLE(owned_parent.as_raw_handle()), INFINITE) };
    match status {
        WAIT_OBJECT_0 => { let _ = destination.post(WM_APP_SHUTDOWN); }
        _ => eprintln!("parent watcher wait failed with result {status:?}"),
    }
}
