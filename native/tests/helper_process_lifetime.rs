//! The helper's process lifetime: readiness, the ways it is told or allowed to stop, and bad input.
#![cfg(windows)]

mod support;

use serde_json::json;
use serial_test::serial;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use support::{HelperProcess, STEP, ready, stand_in_parent};

#[test]
#[serial]
fn it_announces_readiness_and_stops_on_a_shutdown_command() {
    let mut helper = HelperProcess::ready(std::process::id());
    helper.send_raw(b"{\"type\":\"shutdown\"}\n");
    let (status, events) = helper.exit(STEP);
    assert!(status.success());
    assert_eq!(events, [ready()], "nothing but readiness is printed");
}

#[test]
#[serial]
fn closing_stdin_stops_it_cleanly_even_when_its_parent_never_existed() {
    for parent in [std::process::id(), u32::MAX] {
        let mut helper = HelperProcess::ready(parent);
        helper.close_input();
        let (status, events) = helper.exit(STEP);
        assert!(status.success(), "parent {parent}");
        assert_eq!(events, [ready()], "parent {parent}");
    }
}

#[test]
#[serial]
fn an_unsupported_protocol_version_is_reported_and_fatal() {
    let mut helper = HelperProcess::launch(std::process::id(), 2);
    let (status, events) = helper.exit(STEP);
    assert!(!status.success());
    assert_eq!(
        events,
        [json!({"type": "error", "code": "protocol-version-mismatch", "message": "unsupported protocol version 2; expected 1", "recoverable": false})]
    );
}

#[test]
#[serial]
fn it_stops_when_its_parent_process_goes_away() {
    let mut parent = stand_in_parent();
    let mut helper = HelperProcess::ready(parent.0.id());
    parent.stop();
    let (status, events) = helper.exit(STEP);
    assert!(status.success());
    assert_eq!(events, [ready()]);
}

#[test]
#[serial]
fn a_bad_line_is_a_recoverable_error_and_the_helper_carries_on() {
    let too_long = {
        let mut line = vec![b'{'; firefly_screenshot::protocol::MAX_NDJSON_LINE_BYTES + 1];
        line.push(b'\n');
        line
    };
    for (input, code) in [(b"{oops\n".to_vec(), "invalid-command"), (too_long, "line-too-long")] {
        let mut helper = HelperProcess::ready(std::process::id());
        helper.send_raw(&input);
        let error = helper.event();
        assert_eq!((error["type"].as_str(), error["code"].as_str(), error["recoverable"].as_bool()), (Some("error"), Some(code), Some(true)));
        helper.send_raw(b"{\"type\":\"shutdown\"}\n");
        let (status, events) = helper.exit(STEP);
        assert!(status.success(), "{code}");
        assert_eq!(events, [ready(), error], "{code}");
    }
}

/// Floods stdin with `line` while the UI thread is frozen, removes the parent, thaws the UI thread and
/// checks that the helper still exits by itself, printing only `expected` after readiness.
fn parent_exit_under_flood(line: &'static [u8], minimum_backlog: usize, expected: impl Fn(&serde_json::Value) -> bool) {
    let mut parent = stand_in_parent();
    let mut helper = HelperProcess::ready(parent.0.id());
    let mut frozen = helper.freeze_ui();

    let mut input = helper.take_input();
    let lines_written = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&lines_written);
    let (writer_stopped, writer_done) = mpsc::channel();
    thread::spawn(move || {
        let burst = line.repeat(128);
        while input.write_all(&burst).is_ok() {
            counter.fetch_add(128, Ordering::Release);
        }
        let _ = writer_stopped.send(());
    });

    // Wait until a backlog exists: enough lines written, or the pipe stopped accepting more.
    let until = Instant::now() + Duration::from_secs(10);
    let mut last = (0, Instant::now());
    loop {
        let written = lines_written.load(Ordering::Acquire);
        if written >= minimum_backlog * 8 {
            break;
        }
        if written != last.0 {
            last = (written, Instant::now());
        } else if written >= minimum_backlog && last.1.elapsed() >= Duration::from_millis(200) {
            break;
        }
        assert!(Instant::now() < until, "only {written} lines reached the helper before the deadline");
        thread::sleep(Duration::from_millis(5));
    }

    parent.stop();
    thread::sleep(Duration::from_millis(50));
    frozen.thaw();

    let exited = helper.process.exited_within(STEP);
    if exited.is_none() {
        helper.process.stop();
    }
    let _ = writer_done.recv_timeout(STEP);
    let events = helper.drain(STEP);
    assert!(exited.is_some(), "the helper kept running while flooded after its parent exited");
    assert_eq!(events.first(), Some(&ready()));
    assert!(events.len() > 1, "the flood produced responses");
    assert!(events[1..].iter().all(&expected), "unexpected response among {}", events.len());
}

#[test]
#[serial]
fn a_flood_of_bad_lines_does_not_keep_it_alive_after_the_parent_exits() {
    parent_exit_under_flood(b"{oops\n", 1024, |event| {
        event["type"] == "error" && event["code"] == "invalid-command" && event["recoverable"] == true
    });
}

#[test]
#[serial]
fn a_flood_of_commands_does_not_keep_it_alive_after_the_parent_exits() {
    parent_exit_under_flood(b"{\"type\":\"cancel\",\"requestId\":\"deluge\"}\n", 4096, |event| {
        event["type"] == "cancelled" && event["requestId"] == "deluge" && event["reason"] == "no-active-capture"
    });
}
