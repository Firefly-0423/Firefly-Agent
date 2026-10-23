pub mod win;
pub mod request;
pub mod protocol;
pub mod parent_watch;
pub mod ipc;
pub mod geometry;
pub mod error;
pub mod cli;
pub mod app;

#[cfg(feature = "history-read")]
pub mod history_read;

#[cfg(all(windows, feature = "history-read"))]
mod handle_fs;
#[cfg(feature = "workspace-handle")]
pub mod workspace_access;

use windows::Win32::UI::WindowsAndMessaging::WM_APP;

pub const WM_APP_COMMAND: u32 = WM_APP + 1;
pub const WM_APP_SHUTDOWN: u32 = WM_APP + 2;
