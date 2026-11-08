//! Drives a real `firefly-screenshot` process the way Main does: NDJSON commands on stdin, events on stdout,
//! and window messages posted to its overlay in place of a person's mouse and keyboard.
#![allow(dead_code)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{OpenThread, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME};
use windows::Win32::UI::Input::KeyboardAndMouse::{VIRTUAL_KEY, VK_ESCAPE, VK_RETURN};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetWindowThreadProcessId, HWND_MESSAGE, PostMessageW, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
};
use windows::core::{PCWSTR, w};

/// How long any single expected event may take.
pub const STEP: Duration = Duration::from_secs(2);
/// Startup must announce readiness within this time.
pub const STARTUP: Duration = Duration::from_secs(3);
/// Waiting for an encode that runs beside other events.
pub const ENCODE: Duration = Duration::from_secs(15);

pub fn ready() -> Value {
    json!({"type": "ready", "protocolVersion": 1})
}

pub fn start(request_id: &str, mode: &str) -> Value {
    json!({"type": "start", "requestId": request_id, "mode": mode})
}

pub fn cancel(request_id: &str) -> Value {
    json!({"type": "cancel", "requestId": request_id})
}

/// A child process that is always gone when its owner is dropped.
pub struct Reaped(pub Child);

impl Reaped {
    pub fn exited_within(&mut self, limit: Duration) -> Option<ExitStatus> {
        let until = Instant::now() + limit;
        loop {
            if let Some(status) = self.0.try_wait().expect("child status can be polled") {
                return Some(status);
            }
            if Instant::now() >= until {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn stop(&mut self) -> ExitStatus {
        if let Some(status) = self.exited_within(Duration::ZERO) {
            return status;
        }
        let _ = self.0.kill();
        self.exited_within(STEP).expect("a killed child is reaped promptly")
    }
}

impl Drop for Reaped {
    fn drop(&mut self) {
        if self.exited_within(Duration::ZERO).is_none() {
            let _ = self.0.kill();
            let _ = self.exited_within(STEP);
        }
    }
}

/// A process that only exists to be the helper's parent and then go away.
pub fn stand_in_parent() -> Reaped {
    Reaped(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("a stand-in parent starts"),
    )
}

pub fn captures_folder() -> PathBuf {
    std::env::temp_dir().join("firefly-screenshot-helper-tests")
}

/// An empty captures folder, recreated for each test that inspects files.
pub fn empty_captures_folder() -> PathBuf {
    let folder = captures_folder();
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).expect("the captures folder can be created");
    folder
}

pub fn files_ending(folder: &Path, suffix: &str) -> Vec<String> {
    std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.to_ascii_lowercase().ends_with(suffix))
                .collect()
        })
        .unwrap_or_default()
}

/// Keeps the helper's UI thread frozen so input piles up, until resumed or dropped.
pub struct FrozenUi {
    thread: OwnedHandle,
    frozen: bool,
}

impl FrozenUi {
    pub fn thaw(&mut self) {
        if std::mem::take(&mut self.frozen) {
            // SAFETY: the handle was opened with suspend/resume rights and is still owned here.
            let previous = unsafe { ResumeThread(HANDLE(self.thread.as_raw_handle())) };
            assert_ne!(previous, u32::MAX, "the helper's UI thread resumes");
        }
    }
}

impl Drop for FrozenUi {
    fn drop(&mut self) {
        if self.frozen {
            // SAFETY: as in thaw; best effort while unwinding.
            let _ = unsafe { ResumeThread(HANDLE(self.thread.as_raw_handle())) };
        }
    }
}

pub struct HelperProcess {
    pub process: Reaped,
    input: Option<ChildStdin>,
    lines: Receiver<String>,
    reader_finished: Receiver<Result<(), String>>,
    seen: Vec<String>,
}

impl HelperProcess {
    pub fn launch(parent_pid: u32, protocol_version: u32) -> Self {
        Self::launch_into(parent_pid, protocol_version, &captures_folder())
    }

    pub fn launch_into(parent_pid: u32, protocol_version: u32, output_dir: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_firefly-screenshot"))
            .arg("--output-dir")
            .arg(output_dir)
            .args(["--protocol-version", &protocol_version.to_string(), "--parent-pid", &parent_pid.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the helper binary starts");

        let (line_sender, lines) = mpsc::channel();
        let (finish_sender, reader_finished) = mpsc::channel();
        let stdout = child.stdout.take().expect("piped stdout");
        thread::spawn(move || {
            let mut outcome = Ok(());
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if line_sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        outcome = Err(error.to_string());
                        break;
                    }
                }
            }
            drop(line_sender);
            let _ = finish_sender.send(outcome);
        });
        let stderr = child.stderr.take().expect("piped stderr");
        thread::spawn(move || BufReader::new(stderr).lines().map_while(Result::ok).for_each(|line| eprintln!("[helper] {line}")));

        let input = child.stdin.take();
        Self { process: Reaped(child), input, lines, reader_finished, seen: Vec::new() }
    }

    /// A helper that has already announced it is ready.
    pub fn ready(parent_pid: u32) -> Self {
        let mut helper = Self::launch(parent_pid, 1);
        assert_eq!(helper.event_within(STARTUP), ready());
        helper
    }

    pub fn ready_into(output_dir: &Path) -> Self {
        let mut helper = Self::launch_into(std::process::id(), 1, output_dir);
        assert_eq!(helper.event_within(STARTUP), ready());
        helper
    }

    pub fn event_within(&mut self, limit: Duration) -> Value {
        let line = match self.lines.recv_timeout(limit) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => panic!("no event within {limit:?}; seen so far: {:?}", self.seen),
            Err(RecvTimeoutError::Disconnected) => panic!("stdout closed; seen: {:?}", self.seen),
        };
        let event = serde_json::from_str(&line).unwrap_or_else(|error| panic!("stdout line {line:?} is not JSON: {error}"));
        self.seen.push(line);
        event
    }

    pub fn event(&mut self) -> Value {
        self.event_within(STEP)
    }

    /// Reads events until `wanted` matches one, within `limit`; the others are returned in order.
    pub fn until(&mut self, limit: Duration, wanted: impl Fn(&Value) -> bool) -> (Value, Vec<Value>) {
        let until = Instant::now() + limit;
        let mut skipped = Vec::new();
        while Instant::now() < until {
            let event = self.event();
            if wanted(&event) {
                return (event, skipped);
            }
            skipped.push(event);
        }
        panic!("no matching event within {limit:?}; skipped {skipped:?}");
    }

    pub fn send(&mut self, command: &Value) {
        let input = self.input.as_mut().expect("stdin is still open");
        writeln!(input, "{command}").expect("a command can be written");
        input.flush().expect("the command is flushed");
    }

    pub fn send_raw(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().expect("stdin is still open");
        input.write_all(bytes).expect("raw input can be written");
        input.flush().expect("raw input is flushed");
    }

    pub fn close_input(&mut self) {
        self.input = None;
    }

    pub fn take_input(&mut self) -> ChildStdin {
        self.input.take().expect("stdin is still open")
    }

    /// Everything the helper printed, once it has exited and its stdout is closed.
    pub fn drain(&mut self, limit: Duration) -> Vec<Value> {
        self.reader_finished
            .recv_timeout(limit)
            .expect("stdout reaches end of file")
            .expect("stdout is read without error");
        self.seen.extend(self.lines.try_iter());
        self.seen.iter().map(|line| serde_json::from_str(line).expect("every stdout line is JSON")).collect()
    }

    /// Waits for the process to exit on its own, then returns its status and every event it printed.
    pub fn exit(&mut self, limit: Duration) -> (ExitStatus, Vec<Value>) {
        let status = self.process.exited_within(limit).expect("the helper exits in time");
        (status, self.drain(limit))
    }

    pub fn shut_down(mut self) {
        self.send(&json!({"type": "shutdown"}));
        assert!(self.exit(STEP).0.success(), "shutdown exits cleanly");
    }

    fn window(&self, parent: Option<HWND>, class: PCWSTR) -> HWND {
        let pid = self.process.0.id();
        let until = Instant::now() + STARTUP;
        loop {
            let mut previous = None;
            // SAFETY: FindWindowExW only reads the class name; the returned handles are not dereferenced.
            while let Ok(window) = unsafe { FindWindowExW(parent, previous, class, PCWSTR::null()) } {
                let mut owner = 0;
                // SAFETY: owner is writable storage for the process id.
                unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
                if owner == pid {
                    return window;
                }
                previous = Some(window);
            }
            assert!(Instant::now() < until, "the helper window did not appear");
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn overlay(&self) -> HWND {
        self.window(None, w!("FireflyScreenshotOverlayWindow"))
    }

    pub fn freeze_ui(&self) -> FrozenUi {
        let runtime = self.window(Some(HWND_MESSAGE), w!("FireflyScreenshotRuntimeWindow"));
        // SAFETY: the window belongs to the helper; its thread id is all we read.
        let thread_id = unsafe { GetWindowThreadProcessId(runtime, None) };
        // SAFETY: opening a thread of a child process we started, with suspend/resume rights only.
        let raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread_id) }.expect("the UI thread can be opened");
        // SAFETY: OpenThread returned a new handle that nothing else owns.
        let thread = unsafe { OwnedHandle::from_raw_handle(raw.0) };
        // SAFETY: the handle is valid and has suspend rights.
        let previous = unsafe { SuspendThread(HANDLE(thread.as_raw_handle())) };
        assert_ne!(previous, u32::MAX, "the UI thread suspends");
        FrozenUi { thread, frozen: true }
    }

    /// Sends `start` and checks the three events every capture opens with; returns the overlay-visible event.
    pub fn open_capture(&mut self, request_id: &str, mode: &str) -> Value {
        self.send(&start(request_id, mode));
        assert_eq!(self.event(), json!({"type": "accepted", "requestId": request_id}));
        assert_eq!(self.event(), json!({"type": "interaction-state", "requestId": request_id, "state": "selecting"}));
        let shown = self.event();
        assert_eq!((shown["type"].as_str(), shown["requestId"].as_str()), (Some("overlay-visible"), Some(request_id)));
        shown
    }

    /// Drags a selection on the overlay and waits for the helper to call it selected.
    pub fn drag(&mut self, from: (i32, i32), to: (i32, i32)) {
        let overlay = self.overlay();
        let at = |(x, y): (i32, i32)| LPARAM((((y as u32) & 0xffff) << 16 | ((x as u32) & 0xffff)) as isize);
        // SAFETY: posting ordinary mouse messages to the helper's own overlay window.
        unsafe {
            PostMessageW(Some(overlay), WM_LBUTTONDOWN, WPARAM(1), at(from)).expect("button down is posted");
            PostMessageW(Some(overlay), WM_MOUSEMOVE, WPARAM(1), at(to)).expect("move is posted");
            PostMessageW(Some(overlay), WM_LBUTTONUP, WPARAM(0), at(to)).expect("button up is posted");
        }
        assert_eq!(self.event()["state"], "selected");
    }

    pub fn key(&self, key: VIRTUAL_KEY) {
        // SAFETY: posting a key press to the helper's own overlay window.
        unsafe { PostMessageW(Some(self.overlay()), WM_KEYDOWN, WPARAM(key.0 as usize), LPARAM(0)) }.expect("the key is posted");
    }

    pub fn post(&self, message: u32, wparam: usize) {
        // SAFETY: posting a message to the helper's own overlay window.
        unsafe { PostMessageW(Some(self.overlay()), message, WPARAM(wparam), LPARAM(0)) }.expect("the message is posted");
    }

    /// Opens a capture, selects a region, confirms it with Enter and returns the capture-released event.
    pub fn take_shot(&mut self, request_id: &str, mode: &str, from: (i32, i32), to: (i32, i32)) -> Value {
        self.open_capture(request_id, mode);
        self.drag(from, to);
        self.key(VK_RETURN);
        assert_eq!(self.event(), json!({"type": "interaction-state", "requestId": request_id, "state": "committing"}));
        let released = self.event();
        assert_eq!((released["type"].as_str(), released["requestId"].as_str()), (Some("capture-released"), Some(request_id)));
        released
    }

    pub fn escape(&self) {
        self.key(VK_ESCAPE);
    }
}
