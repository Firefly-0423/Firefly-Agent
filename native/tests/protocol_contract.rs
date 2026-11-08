//! The NDJSON command protocol and command-line contract between Main and the screenshot helper.

use firefly_screenshot::cli::parse_arguments;
use firefly_screenshot::protocol::{CaptureMode, Command, Event, MAX_NDJSON_LINE_BYTES, parse_command_line};
use std::path::PathBuf;

/// Error code the helper reports for a command line, or "ok" when it parses.
fn command_outcome(line: &str) -> String {
    match parse_command_line(line) {
        Ok(_) => "ok".to_owned(),
        Err(error) => error.code().to_owned(),
    }
}

fn cli(output_dir: &str) -> Vec<String> {
    ["--output-dir", output_dir, "--protocol-version", "1", "--parent-pid", "1"].iter().map(|part| part.to_string()).collect()
}

#[test]
fn a_clipboard_only_start_names_its_request_and_mode() {
    let id = "5f0c1d2e-0000-4000-8000-00000000c11b";
    let line = format!(r#"{{"type":"start","requestId":"{id}","mode":"clipboard-only"}}"#);
    let parsed = parse_command_line(&line).expect("a well-formed start parses");
    assert_eq!(parsed, Command::Start { request_id: id.to_owned(), mode: CaptureMode::ClipboardOnly });
}

#[test]
fn a_start_carries_a_mode_and_never_a_caller_source() {
    // Main decides why a capture starts; the helper only accepts how to deliver it.
    let cases = [
        (r#"{"type":"start","requestId":"r","source":"hotkey"}"#, "invalid-command"),
        (r#"{"type":"start","requestId":"r","mode":"clipboard-only","source":"tray"}"#, "invalid-command"),
        (r#"{"type":"start","requestId":"r","mode":"clipboard-only"}"#, "ok"),
    ];
    for (line, expected) in cases {
        assert_eq!(command_outcome(line), expected, "{line}");
    }
}

#[test]
fn a_line_one_byte_over_the_limit_is_refused_before_parsing() {
    assert_eq!(command_outcome(&"{".repeat(MAX_NDJSON_LINE_BYTES + 1)), "line-too-long");
}

#[test]
fn the_command_line_names_an_absolute_output_folder_protocol_and_parent() {
    let options = parse_arguments(cli(r"D:\Firefly\captures")).expect("complete arguments parse");
    assert_eq!(options.output_dir, PathBuf::from(r"D:\Firefly\captures"));
    assert_eq!((options.protocol_version, options.parent_pid), (1, 1));

    let relative = parse_arguments(cli("captures")).expect_err("a relative folder is refused");
    assert_eq!(relative.code(), "invalid-arguments");
}

#[test]
fn a_completed_event_says_whether_it_was_annotated_but_not_how() {
    let completed = Event::Completed {
        request_id: "r".into(),
        file_name: None,
        width: 4,
        height: 3,
        mime: "image/png",
        clipboard_written: true,
        has_annotations: true,
    };
    let wire = serde_json::to_value(completed).expect("events serialize");
    assert_eq!(wire["hasAnnotations"], serde_json::Value::Bool(true));
    assert!(wire.as_object().is_some_and(|fields| !fields.contains_key("annotations")));
}
