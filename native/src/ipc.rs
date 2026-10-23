use std::{
    io::{self, BufRead, BufReader, Write},
    sync::{mpsc::{self, Receiver, Sender}, Arc, Mutex, MutexGuard},
    thread::{self, JoinHandle},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::PostMessageW,
};
use crate::{
    protocol::{parse_command_line, Command, Event, MAX_NDJSON_LINE_BYTES},
    WM_APP_COMMAND, WM_APP_SHUTDOWN,
};

pub struct RuntimeChannels {
    pub command_rx: Receiver<Command>,
    pub event_tx: Sender<Event>,
}

pub struct InputBatch {
    pub commands: Vec<Command>,
    pub events: Vec<Event>,
}

#[derive(Clone, Copy)]
pub struct MessageTarget(usize);

impl MessageTarget {
    pub fn new(hwnd: HWND) -> Self { Self(hwnd.0 as usize) }

    pub fn post(self, message: u32) -> windows::core::Result<()> {
        // SAFETY: This address identifies the runtime HWND; data travels over mpsc.
        unsafe {
            PostMessageW(Some(HWND(self.0 as *mut _)), message, WPARAM(0), LPARAM(0))
        }
    }
}

#[derive(Clone)]
pub struct InputGate {
    shared: Arc<Mutex<GateQueues>>,
    destination: MessageTarget,
}

struct GateQueues {
    commands: Option<Sender<Command>>,
    errors: Option<Sender<Event>>,
    next_command: Option<Command>,
    next_error: Option<Event>,
    notified: bool,
    stopped: bool,
}

pub fn create_runtime_channels(
    target: MessageTarget,
) -> (RuntimeChannels, InputGate, Receiver<Event>, Receiver<Event>) {
    let (commands, incoming) = mpsc::channel();
    let (outgoing, published) = mpsc::channel();
    let (errors, rejected) = mpsc::channel();
    let gate = InputGate {
        destination: target,
        shared: Arc::new(Mutex::new(GateQueues {
            commands: Some(commands), errors: Some(errors),
            next_command: None, next_error: None, notified: false, stopped: false,
        })),
    };
    (RuntimeChannels { command_rx: incoming, event_tx: outgoing }, gate, published, rejected)
}

impl InputGate {
    fn acquire(&self) -> MutexGuard<'_, GateQueues> {
        match self.shared.lock() {
            Ok(locked) => locked,
            Err(poisoned) => {
                eprintln!("input gate mutex was poisoned; recovering");
                poisoned.into_inner()
            }
        }
    }

    fn notify(&self, queues: &mut GateQueues) -> bool {
        if queues.notified { return true; }
        queues.notified = true;
        match self.destination.post(WM_APP_COMMAND) {
            Ok(()) => true,
            Err(_) => { queues.notified = false; false }
        }
    }

    pub fn submit_command(&self, command: Command) -> bool {
        let mut locked = self.acquire();
        if locked.stopped { return false; }
        let delivered = match &locked.commands {
            Some(sender) => sender.send(command).is_ok(),
            None => false,
        };
        delivered && self.notify(&mut locked)
    }

    pub fn submit_event(&self, event: Event) -> bool {
        let mut locked = self.acquire();
        if locked.stopped { return false; }
        let delivered = match &locked.errors {
            Some(sender) => sender.send(event).is_ok(),
            None => false,
        };
        delivered && self.notify(&mut locked)
    }

    pub fn drain_batch(
        &self, command_rx: &Receiver<Command>, event_rx: &Receiver<Event>, limit_per_queue: usize,
    ) -> InputBatch {
        let mut locked = self.acquire();
        let (commands, commands_remain) = receive_batch(&mut locked.next_command, command_rx, limit_per_queue);
        let (events, errors_remain) = receive_batch(&mut locked.next_error, event_rx, limit_per_queue);
        locked.notified = commands_remain || errors_remain;
        if locked.notified && self.destination.post(WM_APP_COMMAND).is_err() {
            locked.notified = false;
        }
        InputBatch { commands, events }
    }

    pub fn close(&self) -> Vec<Event> {
        let (old_commands, old_errors, last_error) = {
            let mut locked = self.acquire();
            locked.stopped = true;
            locked.notified = false;
            locked.next_command.take();
            (locked.commands.take(), locked.errors.take(), locked.next_error.take())
        };
        drop(old_commands);
        drop(old_errors);
        last_error.into_iter().collect()
    }
}

fn receive_batch<T>(saved: &mut Option<T>, source: &Receiver<T>, maximum: usize) -> (Vec<T>, bool) {
    let mut collected = Vec::with_capacity(maximum);
    collected.extend(saved.take());
    while collected.len() < maximum {
        let Ok(value) = source.try_recv() else { return (collected, false); };
        collected.push(value);
    }
    *saved = source.try_recv().ok();
    let more = saved.is_some();
    (collected, more)
}

pub fn spawn_stdin_reader(target: MessageTarget, input_gate: InputGate) {
    thread::Builder::new()
        .name(String::from("firefly-stdin"))
        .spawn(move || {
            let input = io::stdin();
            let mut buffered = BufReader::new(input.lock());
            loop {
                let notification = match read_capped_line(&mut buffered) {
                    Ok(InputLine::Line(raw)) => match decode_command(&raw) {
                        Ok(parsed) => {
                            let exits = matches!(parsed, Command::Shutdown);
                            if !input_gate.submit_command(parsed) || exits { return; }
                            continue;
                        }
                        Err((kind, description)) => Event::Error {
                            request_id: None, code: kind.into(), message: description, recoverable: true,
                        },
                    },
                    Ok(InputLine::TooLong) => Event::Error {
                        request_id: None,
                        code: String::from("line-too-long"),
                        message: format!("NDJSON line exceeds {MAX_NDJSON_LINE_BYTES} bytes"),
                        recoverable: true,
                    },
                    Ok(InputLine::Eof) => { let _ = target.post(WM_APP_SHUTDOWN); return; }
                    Err(read_failure) => {
                        eprintln!("stdin reader failed: {read_failure}");
                        let _ = target.post(WM_APP_SHUTDOWN);
                        return;
                    }
                };
                if !input_gate.submit_event(notification) { return; }
            }
        })
        .expect("failed to start stdin reader");
}

fn decode_command(raw: &[u8]) -> Result<Command, (&'static str, String)> {
    let text = std::str::from_utf8(raw).map_err(|bad_utf8| (
        "invalid-command", format!("invalid command: input is not UTF-8: {bad_utf8}"),
    ))?;
    parse_command_line(text).map_err(|invalid| (invalid.code(), invalid.to_string()))
}

pub fn spawn_stdout_writer(event_rx: Receiver<Event>) -> JoinHandle<io::Result<()>> {
    thread::Builder::new()
        .name(String::from("firefly-stdout"))
        .spawn(move || {
            let output = io::stdout();
            let mut locked_output = output.lock();
            for notification in event_rx {
                write_event(&mut locked_output, &notification)?;
            }
            Ok(())
        })
        .expect("failed to start stdout writer")
}

pub fn write_event(writer: &mut impl Write, event: &Event) -> io::Result<()> {
    let encoded = serde_json::to_writer(&mut *writer, event);
    encoded.map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

enum InputLine { Line(Vec<u8>), TooLong, Eof }

fn read_capped_line(reader: &mut impl BufRead) -> io::Result<InputLine> {
    let mut bytes = Vec::new();
    let mut discarded = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(match (discarded, bytes.is_empty()) {
                (true, _) => InputLine::TooLong,
                (false, true) => InputLine::Eof,
                (false, false) => InputLine::Line(bytes),
            });
        }
        let delimiter = chunk.iter().position(|value| *value == b'\n');
        let count = delimiter.unwrap_or(chunk.len());
        if !discarded {
            if bytes.len() + count > MAX_NDJSON_LINE_BYTES {
                bytes.clear();
                discarded = true;
            } else {
                bytes.extend_from_slice(&chunk[..count]);
            }
        }
        reader.consume(count + usize::from(delimiter.is_some()));
        if delimiter.is_none() { continue; }
        if bytes.last() == Some(&b'\r') { bytes.pop(); }
        return Ok(if discarded { InputLine::TooLong } else { InputLine::Line(bytes) });
    }
}
