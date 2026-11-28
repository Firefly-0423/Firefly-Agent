//! Where a confirmed capture goes: the clipboard only, or the clipboard plus a PNG written in the background.
#![cfg(windows)]

mod support;

use serde_json::{Value, json};
use serial_test::serial;
use std::time::Duration;
use support::{ENCODE, HelperProcess, STEP, cancel, empty_captures_folder, files_ending, start};

const FILE: &str = "clipboard-and-file";

#[test]
#[serial]
fn clipboard_only_writes_nothing_to_disk() {
    let folder = empty_captures_folder();
    let mut helper = HelperProcess::ready_into(&folder);
    helper.take_shot("copy-only", "clipboard-only", (30, 30), (90, 100));
    let completed = helper.event();
    assert_eq!((completed["type"].as_str(), completed["requestId"].as_str()), (Some("completed"), Some("copy-only")));
    assert_eq!(completed["fileName"], Value::Null);
    // Give a wrongly started background encode time to show up.
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(std::fs::read_dir(&folder).map(Iterator::count).unwrap_or(0), 0, "the captures folder stays empty");
    helper.shut_down();
}

#[test]
#[serial]
fn a_file_capture_encodes_in_the_background_while_the_next_capture_starts() {
    let folder = empty_captures_folder();
    let mut helper = HelperProcess::ready_into(&folder);
    let released = helper.take_shot("to-disk", FILE, (40, 36), (170, 130));
    let size = (released["width"].as_u64(), released["height"].as_u64());

    // Start another capture before the encode has reported; its events and the encode's completion may interleave.
    helper.send(&start("meanwhile", "clipboard-only"));
    let mut completed = None;
    let mut next_capture = Vec::new();
    while completed.is_none() || !next_capture.iter().any(|event: &Value| event["type"] == "overlay-visible") {
        let event = helper.event_within(ENCODE);
        match (event["type"].as_str(), event["requestId"].as_str()) {
            (Some("completed"), Some("to-disk")) => completed = Some(event),
            (Some("accepted" | "interaction-state" | "overlay-visible"), Some("meanwhile")) => next_capture.push(event),
            _ => panic!("unexpected event while encoding: {event}"),
        }
    }
    let kinds: Vec<_> = next_capture.iter().map(|event| event["type"].as_str().unwrap_or_default().to_owned()).collect();
    assert_eq!(kinds, ["accepted", "interaction-state", "overlay-visible"], "the next capture opened normally");

    let completed = completed.expect("the encode finished");
    assert_eq!((completed["width"].as_u64(), completed["height"].as_u64()), size, "the file has the released size");
    assert_eq!(completed["mime"], "image/png");
    let name = completed["fileName"].as_str().expect("a file capture names its file").to_owned();
    let stem = name.strip_suffix(".png").expect("the file is a .png");
    assert!(uuid::Uuid::parse_str(stem).is_ok(), "the file is named by a UUID: {name}");
    let written = std::fs::metadata(folder.join(&name)).expect("the file exists");
    assert!(written.is_file() && written.len() > 0);
    assert_eq!(files_ending(&folder, ".png"), [name], "exactly one PNG is written");
    assert!(files_ending(&folder, ".tmp").is_empty(), "no temporary file is left behind");
    helper.shut_down();
}

#[test]
#[serial]
fn an_encode_that_cannot_write_reports_a_fatal_error_and_leaves_no_temporary_file() {
    // The output "folder" is an ordinary file, so creating the temporary PNG beside it fails.
    let folder = empty_captures_folder();
    let blocked = folder.join("occupied-by-a-file");
    std::fs::write(&blocked, b"not a folder").expect("the blocking file is written");

    let mut helper = HelperProcess::ready_into(&blocked);
    let released = helper.take_shot("cannot-save", FILE, (40, 36), (170, 130));
    assert_eq!(released["clipboardWritten"], true, "the clipboard copy does not depend on the disk");

    let (outcome, _) = helper.until(ENCODE, |event| event["requestId"] == "cannot-save" && matches!(event["type"].as_str(), Some("error" | "completed")));
    assert_eq!(
        (outcome["type"].as_str(), outcome["code"].as_str(), outcome["recoverable"].as_bool()),
        (Some("error"), Some("encode-failed"), Some(false)),
        "{outcome}"
    );
    assert!(files_ending(&folder, ".tmp").is_empty(), "no temporary file is left behind");

    helper.send(&json!({"type": "shutdown"}));
    assert!(helper.exit(STEP).0.success(), "a failed encode does not stop the helper from exiting cleanly");
}

#[test]
#[serial]
fn cancelling_during_the_encode_ends_the_request_and_frees_its_id() {
    let mut helper = HelperProcess::ready_into(&empty_captures_folder());
    helper.take_shot("stop-it", FILE, (32, 32), (128, 96));
    helper.send(&cancel("stop-it"));

    // Either the cancel or the encode may finish the request first; both free the id.
    let terminal = |event: &Value| event["requestId"] == "stop-it" && matches!(event["type"].as_str(), Some("cancelled" | "completed" | "error"));
    helper.until(Duration::from_secs(10), terminal);

    helper.send(&start("stop-it", "clipboard-only"));
    helper.until(Duration::from_secs(10), |event| event["type"] == "accepted" && event["requestId"] == "stop-it");

    helper.send(&cancel("stop-it"));
    helper.until(Duration::from_secs(10), |event| event["type"] == "cancelled" && event["requestId"] == "stop-it" && event["reason"] == "electron-cancelled");
    helper.shut_down();
}
