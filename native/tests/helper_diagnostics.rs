//! Capture diagnostics: which backend froze the screen and how many times pixels were copied back to the CPU.
#![cfg(windows)]

mod support;

use serde_json::Value;
use serial_test::serial;
use support::HelperProcess;

const COUNTERS: [&str; 4] = ["fullFrameCpuReadbacks", "selectionCpuReadbacks", "latestCopies", "duplicationRebuilds"];

fn counter(event: &Value, name: &str) -> u64 {
    event["diagnostics"][name].as_u64().unwrap_or_else(|| panic!("diagnostics.{name} is a whole number in {event}"))
}

#[test]
#[serial]
fn showing_the_overlay_reports_the_backend_and_every_counter() {
    let mut helper = HelperProcess::ready(std::process::id());
    let shown = helper.open_capture("counters", "clipboard-only");
    assert!(shown["diagnostics"]["backend"].is_string(), "{shown}");
    for name in COUNTERS {
        counter(&shown, name);
    }
    helper.shut_down();
}

#[test]
#[serial]
fn freezing_reads_the_full_frame_back_only_on_the_gdi_fallback() {
    // DXGI keeps the frozen frame on the GPU; GDI copies the whole screen into memory exactly once.
    let mut helper = HelperProcess::ready(std::process::id());
    let shown = helper.open_capture("readbacks", "clipboard-only");
    let full_frame = counter(&shown, "fullFrameCpuReadbacks");
    match shown["diagnostics"]["backend"].as_str() {
        Some("dxgi") => assert_eq!(full_frame, 0),
        Some("gdi") => assert_eq!(full_frame, 1),
        other => panic!("unknown backend {other:?}"),
    }
    assert!(counter(&shown, "latestCopies") >= 1, "a frozen frame was copied at least once");
    assert_eq!(counter(&shown, "selectionCpuReadbacks"), 0, "nothing is selected yet");
    helper.shut_down();
}

#[test]
#[serial]
fn confirming_a_selection_reads_only_that_region_back() {
    let mut helper = HelperProcess::ready(std::process::id());
    let released = helper.take_shot("region", "clipboard-only", (32, 32), (96, 96));
    assert!(counter(&released, "selectionCpuReadbacks") >= 1);
    assert!(counter(&released, "latestCopies") >= 1);
    assert_eq!(helper.event()["type"], "completed");
    helper.shut_down();
}
