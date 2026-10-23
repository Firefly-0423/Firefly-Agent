use std::{
    path::PathBuf,
    sync::{mpsc::{Receiver, Sender}, Arc, Mutex},
};
use windows::{
    core::{w, Error as WindowsError, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WAIT_FAILED, WPARAM},
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, HWND_MESSAGE,
            MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW,
            QS_ALLINPUT, RegisterClassW, TranslateMessage, UnregisterClassW,
            WINDOW_EX_STYLE, WINDOW_STYLE, WM_QUIT, WNDCLASSW,
        },
    },
};
use crate::{
    cli::CliOptions,
    error::{AppError, HelperError},
    geometry::{PointI, RectI},
    ipc::{create_runtime_channels, spawn_stdin_reader, spawn_stdout_writer, InputGate, MessageTarget, RuntimeChannels},
    parent_watch,
    protocol::{CaptureMode, Command, Event, InteractionStateEvent, PROTOCOL_VERSION},
    request::RequestRegistry,
    win::{
        capture::{CaptureBackend, FrozenFrame, RefreshOutcome},
        capture_dxgi::DxgiCaptureBackend,
        capture_gdi::GdiCaptureBackend,
        clipboard::write_cf_dibv5,
        display::{query_primary_display, DisplayInfo},
        encoder::{self, EncodeJob},
        renderer::{burn_annotations, present_first_frame, qpc_elapsed_ms, qpc_now, OverlayRenderer},
        window::{OverlayAction, OverlayWindow},
    },
    WM_APP_COMMAND, WM_APP_SHUTDOWN,
};

const RUNTIME_CLASS: PCWSTR = w!("FireflyScreenshotRuntimeWindow");
const QUEUE_SLICE: usize = 64;
const IDLE_WAIT_MS: u32 = 16;

pub fn run(config: CliOptions) -> Result<(), AppError> {
    let runtime = RuntimeWindow::open()?;
    let destination = MessageTarget::new(runtime.handle);
    let (pipes, gate, published, rejected) = create_runtime_channels(destination);
    let output_worker = spawn_stdout_writer(published);
    parent_watch::start(config.parent_pid, destination);
    spawn_stdin_reader(destination, gate.clone());
    pipes.event_tx.send(Event::Ready { protocol_version: PROTOCOL_VERSION })
        .map_err(|_| AppError::Runtime(String::from("stdout writer stopped before ready")))?;

    let ui_outcome = dispatch_loop(&runtime, &pipes, &gate, &rejected, config.output_dir.clone());
    for leftover in gate.close() { let _ = pipes.event_tx.send(leftover); }
    forward_remaining(&pipes.event_tx, &rejected);
    drop(pipes);
    let output_outcome = output_worker.join()
        .map_err(|_| AppError::Runtime(String::from("stdout writer panicked")))?;
    ui_outcome?;
    output_outcome?;
    Ok(())
}

fn forward_remaining(destination: &Sender<Event>, rejected: &Receiver<Event>) {
    for notification in rejected {
        if destination.send(notification).is_err() { break; }
    }
}

fn dispatch_loop(
    runtime: &RuntimeWindow, pipes: &RuntimeChannels, gate: &InputGate,
    rejected: &Receiver<Event>, directory: PathBuf,
) -> Result<(), AppError> {
    let monitor = query_primary_display()?;
    let surface = OverlayWindow::create(&monitor)?;
    let backend: Box<dyn CaptureBackend> = match DxgiCaptureBackend::new(&monitor, false) {
        Err(init_failure) => {
            eprintln!("firefly-screenshot: DXGI init failed ({init_failure}), falling back to GDI");
            Box::new(GdiCaptureBackend::new()?)
        }
        Ok(dxgi) => {
            eprintln!("firefly-screenshot: using DXGI capture backend");
            Box::new(dxgi)
        }
    };
    let mut session = DesktopSession::create(monitor, surface, backend, directory)?;
    let mut incoming = MSG::default();
    loop {
        // SAFETY: PeekMessageW writes into a live MSG on the owning UI thread.
        while unsafe { PeekMessageW(&mut incoming, None, 0, 0, PM_REMOVE) }.as_bool() {
            match incoming.message {
                WM_QUIT | WM_APP_SHUTDOWN => return Ok(()),
                WM_APP_COMMAND if incoming.hwnd == runtime.handle => {
                    let slice = gate.drain_batch(&pipes.command_rx, rejected, QUEUE_SLICE);
                    for notification in slice.events { let _ = pipes.event_tx.send(notification); }
                    for instruction in slice.commands {
                        if !session.dispatch(instruction, &pipes.event_tx) { return Ok(()); }
                    }
                }
                _ => {
                    // SAFETY: The retrieved record belongs to this message queue.
                    unsafe {
                        let _ = TranslateMessage(&incoming);
                        DispatchMessageW(&incoming);
                    }
                    session.apply_action(&pipes.event_tx);
                }
            }
        }
        match pump_capture_if_idle(session.interaction.is_some(), |budget| session.source.refresh_latest(budget)) {
            Err(refresh_failure) => {
                eprintln!("firefly-screenshot: idle DXGI refresh failed ({refresh_failure}); rebuilding capture");
                session.resume_capture()?;
            }
            Ok(Some(RefreshOutcome::Lost)) => session.resume_capture()?,
            Ok(_) => (),
        }
        // A bounded wait also yields when the fallback backend has no frame pump.
        let waited = unsafe { MsgWaitForMultipleObjectsEx(None, IDLE_WAIT_MS, QS_ALLINPUT, MWMO_INPUTAVAILABLE) };
        if waited == WAIT_FAILED { return Err(WindowsError::from_thread().into()); }
    }
}

fn pump_capture_if_idle(
    overlay_active: bool,
    refresh: impl FnOnce(u32) -> Result<RefreshOutcome, HelperError>,
) -> Result<Option<RefreshOutcome>, HelperError> {
    match overlay_active {
        true => Ok(None),
        false => refresh(IDLE_WAIT_MS).map(Some),
    }
}

struct Interaction {
    id: String,
    destination: CaptureMode,
    frozen: FrozenFrame,
}

struct DesktopSession {
    monitor: DisplayInfo,
    surface: OverlayWindow,
    source: Box<dyn CaptureBackend>,
    painter: OverlayRenderer,
    interaction: Option<Interaction>,
    ledger: Arc<Mutex<RequestRegistry>>,
    directory: PathBuf,
}

impl DesktopSession {
    fn create(monitor: DisplayInfo, surface: OverlayWindow, source: Box<dyn CaptureBackend>, directory: PathBuf) -> Result<Self, AppError> {
        Ok(Self {
            monitor, surface, source, painter: OverlayRenderer::new()?, interaction: None,
            ledger: Arc::new(Mutex::new(RequestRegistry::default())), directory,
        })
    }

    fn dispatch(&mut self, instruction: Command, destination: &Sender<Event>) -> bool {
        match instruction {
            Command::Shutdown => return false,
            Command::Start { request_id: id, mode: output } => self.start_request(id, output, destination),
            Command::Cancel { request_id: id } => {
                let visible_match = self.interaction.as_ref().is_some_and(|current| current.id == id);
                if visible_match {
                    self.cancel_request(destination, "electron-cancelled");
                } else if registry_is_pending(&self.ledger, &id) {
                    let _ = destination.send(Event::Cancelled { request_id: id.clone(), reason: String::from("electron-cancelled") });
                    finalize_request(&self.ledger, &id, "cancel");
                } else {
                    let _ = destination.send(Event::Cancelled { request_id: id, reason: String::from("no-active-capture") });
                }
            }
        }
        true
    }

    fn start_request(&mut self, id: String, output: CaptureMode, destination: &Sender<Event>) {
        if self.interaction.is_some() {
            send_error(destination, Some(id.clone()), "busy", "a screenshot interaction is already active", true);
            return;
        }
        let mut locked = match lock_registry(&self.ledger) {
            Ok(locked) => locked,
            Err(_) => {
                send_error(destination, Some(id.clone()), "busy", "request registry is unavailable", true);
                return;
            }
        };
        let accepted = locked.accept(&id, output).map_err(|failure| failure.to_string());
        drop(locked);
        if let Err(reason) = accepted {
            send_error(destination, Some(id.clone()), "busy", &format!("request {id} is already pending: {reason}"), true);
            return;
        }
        let freeze_began = qpc_now();
        let preparation = self.prepare_frozen();
        let frozen = match preparation {
            Ok(frozen) => frozen,
            Err(failure) => {
                finalize_request(&self.ledger, &id, "cancel");
                send_error(destination, Some(id), failure.code(), &failure.to_string(), true);
                return;
            }
        };
        self.interaction = Some(Interaction { id: id.clone(), destination: output, frozen });
        let _ = destination.send(Event::Accepted { request_id: id.clone() });
        let _ = destination.send(Event::InteractionState { request_id: id.clone(), state: InteractionStateEvent::Selecting });
        if let Err(paint_failure) = self.paint_overlay() {
            self.fail_interaction(destination, paint_failure.code(), &paint_failure.to_string(), true);
            return;
        }
        let freeze_finished = qpc_now();
        let elapsed = qpc_elapsed_ms(freeze_began, freeze_finished);
        let _ = destination.send(Event::OverlayVisible {
            request_id: id, freeze_duration_ms: elapsed, diagnostics: self.source.diagnostics(),
        });
    }

    fn prepare_frozen(&mut self) -> Result<FrozenFrame, HelperError> {
        let latest = query_primary_display()?;
        let resized = latest.bounds.width != self.monitor.bounds.width
            || latest.bounds.height != self.monitor.bounds.height
            || latest.rotation != self.monitor.rotation;
        self.monitor = latest;
        if resized { self.resume_capture()?; }
        self.freeze_desktop()
    }

    fn paint_overlay(&mut self) -> Result<(), HelperError> {
        let frozen = self.interaction.as_ref().map(|current| &current.frozen).ok_or_else(|| {
            HelperError::CaptureFailed(String::from("present_overlay called without an active request"))
        })?;
        self.painter.clear_frozen();
        self.surface.attach_renderer(&mut self.painter);
        self.surface.show(&self.monitor)?;
        self.painter.resize(self.surface.hwnd(), &self.monitor)?;
        match frozen {
            FrozenFrame::Cpu(pixels) => self.painter.upload_frozen(pixels)?,
            FrozenFrame::Gpu(texture) => {
                if let Err(upload_failure) = self.painter.upload_frozen_gpu(texture, self.surface.hwnd(), &self.monitor) {
                    eprintln!("firefly-screenshot: GPU upload failed ({upload_failure}), falling back to GDI for this session");
                    let pixels = texture.readback_to_cpu()?;
                    self.painter.upload_frozen(&pixels)?;
                }
            }
        }
        // WM_PAINT can reenter the renderer; no mutable renderer borrow spans this call.
        present_first_frame(&self.surface)?;
        Ok(())
    }

    fn apply_action(&mut self, destination: &Sender<Event>) {
        let Some(pending) = self.surface.take_action() else { return; };
        if pending == OverlayAction::DisplayChanged {
            if self.interaction.is_some() {
                self.fail_interaction(destination, "display-changed", "display topology or DPI changed during capture", true);
            }
            if let Err(recovery_failure) = self.resume_capture() {
                eprintln!("firefly-screenshot: display-change recovery failed: {recovery_failure}");
            }
            return;
        }
        let Some(current) = &self.interaction else { return; };
        let id = current.id.clone();
        match pending {
            OverlayAction::Selected => {
                let _ = destination.send(Event::InteractionState { request_id: id, state: InteractionStateEvent::Selected });
            }
            OverlayAction::Commit => {
                let _ = destination.send(Event::InteractionState { request_id: id.clone(), state: InteractionStateEvent::Committing });
                self.complete_selection(destination);
            }
            OverlayAction::Cancel => self.cancel_request(destination, "user-cancelled"),
            OverlayAction::DisplayChanged => unreachable!("display change handled above"),
        }
    }

    fn resume_capture(&mut self) -> Result<(), HelperError> {
        let latest = query_primary_display()?;
        self.surface.detach_renderer();
        self.painter.reset_gpu_resources();
        if let Err(recovery_failure) = self.source.recover(&latest) {
            eprintln!("firefly-screenshot: {} recovery failed ({recovery_failure}), falling back to GDI", self.source.name());
            self.source = Box::new(GdiCaptureBackend::new()?);
        }
        self.monitor = latest;
        Ok(())
    }

    fn freeze_desktop(&mut self) -> Result<FrozenFrame, HelperError> {
        let initial = self.source.freeze(&self.monitor);
        let frozen = match initial {
            Err(initial_failure) if self.source.name() == "dxgi" => {
                eprintln!("firefly-screenshot: DXGI freeze failed ({initial_failure}); rebuilding before retry");
                self.surface.detach_renderer();
                self.painter.reset_gpu_resources();
                if let Err(recovery_failure) = self.source.recover(&self.monitor) {
                    eprintln!("firefly-screenshot: DXGI rebuild failed ({recovery_failure}); using GDI");
                    self.source = Box::new(GdiCaptureBackend::new()?);
                }
                match self.source.freeze(&self.monitor) {
                    Err(second_failure) if self.source.name() == "dxgi" => {
                        eprintln!("firefly-screenshot: rebuilt DXGI freeze failed ({second_failure}); using GDI");
                        self.source = Box::new(GdiCaptureBackend::new()?);
                        self.source.freeze(&self.monitor)?
                    }
                    retry => retry?,
                }
            }
            other => other?,
        };
        if !self.source.should_fallback_to_gdi() { return Ok(frozen); }
        eprintln!("firefly-screenshot: DXGI cursor policy requires GDI for the current session");
        self.source = Box::new(GdiCaptureBackend::new()?);
        self.source.freeze(&self.monitor)
    }

    fn complete_selection(&mut self, destination: &Sender<Event>) {
        let area = self.surface.selection().unwrap_or(RectI {
            x: 0, y: 0, width: self.monitor.bounds.width, height: self.monitor.bounds.height,
        });
        let marks = self.surface.annotations();
        let annotated = !marks.is_empty();
        let texture = self.interaction.as_ref().and_then(|current| {
            if let FrozenFrame::Gpu(texture) = &current.frozen { Some(texture) } else { None }
        });
        let mut pixels = match self.painter.extract_selection(area, texture) {
            Err(extraction_failure) => {
                self.fail_interaction(destination, "selection-extract-failed", &extraction_failure.to_string(), true);
                return;
            }
            Ok(pixels) => { self.source.record_selection_readback(); pixels }
        };
        burn_annotations(&mut pixels, &marks, PointI { x: area.x, y: area.y });
        let (columns, rows) = (pixels.width, pixels.height);
        eprintln!(
            "firefly-screenshot: committed selection={}x{} at ({},{}) display={:?} rotation={:?} backend={} diag={:?}",
            area.width, area.height, area.x, area.y, self.monitor.bounds, self.monitor.rotation,
            self.source.name(), self.source.diagnostics()
        );
        let copied = match write_cf_dibv5(self.surface.hwnd(), &pixels) {
            Ok(()) => true,
            Err(clipboard_failure) => {
                eprintln!("firefly-screenshot: clipboard write failed: {clipboard_failure}");
                false
            }
        };
        let Some(finished) = self.interaction.take() else { return; };
        self.shutdown_overlay();
        let _ = destination.send(Event::CaptureReleased {
            request_id: finished.id.clone(), clipboard_written: copied,
            width: columns, height: rows, diagnostics: self.source.diagnostics(),
        });
        match lock_registry(&self.ledger) {
            Err(unavailable) => eprintln!("firefly-screenshot: registry capture_released lock unavailable: {unavailable}"),
            Ok(mut locked) => {
                if let Err(release_failure) = locked.capture_released(&finished.id, copied, columns, rows) {
                    eprintln!("firefly-screenshot: registry capture_released failed: {release_failure}");
                }
            }
        }
        match finished.destination {
            CaptureMode::ClipboardOnly => {
                let id = finished.id;
                let _ = destination.send(Event::Completed {
                    request_id: id.clone(), file_name: None, width: columns, height: rows,
                    mime: "image/png", clipboard_written: copied, has_annotations: annotated,
                });
                finalize_request(&self.ledger, &id, "complete");
            }
            CaptureMode::ClipboardAndFile => {
                let filename = encoder::new_png_file_name();
                let work = EncodeJob {
                    request_id: finished.id, file_name: filename, output_dir: self.directory.clone(),
                    frame: pixels, has_annotations: annotated,
                };
                encoder::spawn_encode_job(work, destination.clone(), Arc::clone(&self.ledger));
            }
        }
    }

    fn cancel_request(&mut self, destination: &Sender<Event>, reason: &str) {
        let Some(cancelled) = self.interaction.take() else { return; };
        self.shutdown_overlay();
        let id = cancelled.id;
        let _ = destination.send(Event::Cancelled { request_id: id.clone(), reason: reason.into() });
        finalize_request(&self.ledger, &id, "cancel");
    }

    fn fail_interaction(&mut self, destination: &Sender<Event>, code: &str, message: &str, recoverable: bool) {
        let id = self.interaction.take().map(|current| current.id);
        self.shutdown_overlay();
        if let Some(known) = &id { finalize_request(&self.ledger, known, "cancel"); }
        send_error(destination, id, code, message, recoverable);
    }

    fn shutdown_overlay(&mut self) {
        self.surface.detach_renderer();
        self.painter.clear_frozen();
        let _ = self.surface.hide();
        self.source.invalidate();
    }
}

fn send_error(destination: &Sender<Event>, id: Option<String>, code: &str, description: &str, recoverable: bool) {
    let notification = Event::Error {
        request_id: id, code: code.into(), message: description.into(), recoverable,
    };
    let _ = destination.send(notification);
}

fn lock_registry(registry: &Arc<Mutex<RequestRegistry>>) -> std::sync::LockResult<std::sync::MutexGuard<'_, RequestRegistry>> {
    let locked = registry.lock().unwrap_or_else(|poisoned| {
        eprintln!("firefly-screenshot: requests mutex poisoned, recovering");
        poisoned.into_inner()
    });
    Ok(locked)
}

fn registry_is_pending(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str) -> bool {
    lock_registry(registry).is_ok_and(|locked| locked.is_pending(request_id))
}

fn finalize_request(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str, mode: &str) {
    let mut locked = match lock_registry(registry) {
        Err(_) => { eprintln!("firefly-screenshot: requests finalize lock unavailable"); return; }
        Ok(locked) => locked,
    };
    let finished = if mode == "complete" { locked.complete(request_id, None) } else { locked.cancel(request_id, mode) };
    if let Err(finalize_failure) = finished {
        eprintln!("firefly-screenshot: requests finalize ({mode}) for {request_id} failed: {finalize_failure}");
    }
}

struct RuntimeWindow { handle: HWND }

impl RuntimeWindow {
    fn open() -> Result<Self, AppError> {
        let definition = WNDCLASSW {
            lpfnWndProc: Some(runtime_proc), lpszClassName: RUNTIME_CLASS, ..WNDCLASSW::default()
        };
        // SAFETY: The callback and class name both have static lifetime.
        if unsafe { RegisterClassW(&definition) } == 0 { return Err(WindowsError::from_thread().into()); }
        // SAFETY: This class was registered above; HWND_MESSAGE needs no visible bounds.
        let created = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE::default(), RUNTIME_CLASS, w!(""), WINDOW_STYLE::default(),
                0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None)
        };
        match created {
            Err(creation_failure) => {
                let _ = unsafe { UnregisterClassW(RUNTIME_CLASS, None) };
                Err(creation_failure.into())
            }
            Ok(handle) => Ok(Self { handle }),
        }
    }
}

impl Drop for RuntimeWindow {
    fn drop(&mut self) {
        // SAFETY: Destruction and class cleanup happen on the creating thread.
        let _ = unsafe { DestroyWindow(self.handle) };
        let _ = unsafe { UnregisterClassW(RUNTIME_CLASS, None) };
    }
}

unsafe extern "system" fn runtime_proc(handle: HWND, kind: u32, word: WPARAM, long: LPARAM) -> LRESULT {
    // SAFETY: The original Windows callback arguments pass through unmodified.
    unsafe { DefWindowProcW(handle, kind, word, long) }
}

#[cfg(test)]
mod tests {
    use super::pump_capture_if_idle;
    use crate::win::capture::RefreshOutcome;

    #[test]
    fn idle_capture_pump_refreshes_with_a_bounded_timeout() {
        let actual = pump_capture_if_idle(false, |budget| {
            assert_eq!(budget, 16);
            Ok(RefreshOutcome::Updated)
        }).expect("idle pump should propagate a successful refresh");
        assert_eq!(actual, Some(RefreshOutcome::Updated));
    }

    #[test]
    fn visible_overlay_never_advances_the_live_capture_texture() {
        let actual = pump_capture_if_idle(true, |_| panic!("capture refresh must not run while a frozen overlay is active"))
            .expect("active overlay should be a successful no-op");
        assert_eq!(actual, None);
    }
}
