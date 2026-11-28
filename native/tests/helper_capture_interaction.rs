//! A capture as the person sees it: the frozen overlay, selecting, confirming, cancelling, and interruptions.
#![cfg(windows)]

mod support;

use serde_json::json;
use serial_test::serial;
use support::{HelperProcess, cancel, start};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, WM_DISPLAYCHANGE};

const CLIPBOARD: &str = "clipboard-only";

#[test]
#[serial]
fn the_overlay_appears_quickly_and_shows_the_frozen_desktop() {
    let mut helper = HelperProcess::ready(std::process::id());
    let shown = helper.open_capture("look", CLIPBOARD);
    let freeze_ms = shown["freezeDurationMs"].as_u64().expect("the freeze time is a whole number of milliseconds");
    assert!(freeze_ms < 5_000, "freezing took {freeze_ms} ms");

    // Sample a 3×3 grid of the overlay from the screen: an overlay still painted with its empty-cache grey
    // (0x303030 in COLORREF order) would mean the frozen desktop never reached the window.
    let overlay = helper.overlay();
    assert!(!overlay.is_invalid());
    let mut area = RECT::default();
    // SAFETY: reading the bounds of the helper's own window into local storage.
    unsafe { GetWindowRect(overlay, &mut area) }.expect("the overlay has bounds");
    // SAFETY: the screen DC is released below and only read in between.
    let screen = unsafe { GetDC(None) };
    let samples: Vec<u32> = (1..=3)
        .flat_map(|column| (1..=3).map(move |row| (column, row)))
        .map(|(column, row)| {
            let x = area.left + (area.right - area.left) * column / 4;
            let y = area.top + (area.bottom - area.top) * row / 4;
            // SAFETY: reading one pixel from a valid screen DC.
            unsafe { GetPixel(screen, x, y) }.0
        })
        .collect();
    // SAFETY: releasing the DC obtained above.
    let _ = unsafe { ReleaseDC(None, screen) };
    assert!(samples.iter().any(|&color| color != 0x0030_3030), "the overlay only shows the placeholder grey: {samples:x?}");

    helper.shut_down();
}

#[test]
#[serial]
fn a_drag_selects_a_region_without_disturbing_the_helper() {
    let mut helper = HelperProcess::ready(std::process::id());
    helper.open_capture("drag", CLIPBOARD);
    helper.drag((70, 50), (300, 210));
    helper.shut_down();
}

#[test]
#[serial]
fn enter_copies_the_selection_and_completes_without_a_file() {
    let mut helper = HelperProcess::ready(std::process::id());
    let released = helper.take_shot("confirm", CLIPBOARD, (24, 40), (120, 110));
    assert_eq!(released["clipboardWritten"], true);
    let size = (released["width"].as_u64().expect("width"), released["height"].as_u64().expect("height"));
    assert!((4..100_000).contains(&size.0) && (4..100_000).contains(&size.1), "implausible size {size:?}");

    let completed = helper.event();
    assert_eq!(completed["type"], "completed");
    assert_eq!(completed["requestId"], "confirm");
    assert_eq!(completed["fileName"], serde_json::Value::Null);
    assert_eq!((completed["width"].as_u64(), completed["height"].as_u64()), (Some(size.0), Some(size.1)));
    assert_eq!((completed["mime"].as_str(), completed["clipboardWritten"].as_bool()), (Some("image/png"), Some(true)));
    helper.shut_down();
}

#[test]
#[serial]
fn escape_cancels_and_the_next_capture_can_start() {
    let mut helper = HelperProcess::ready(std::process::id());
    helper.open_capture("never-mind", CLIPBOARD);
    helper.escape();
    assert_eq!(helper.event(), json!({"type": "cancelled", "requestId": "never-mind", "reason": "user-cancelled"}));
    helper.send(&start("second-try", CLIPBOARD));
    assert_eq!(helper.event()["type"], "accepted");
    helper.shut_down();
}

#[test]
#[serial]
fn a_second_start_while_one_is_open_is_busy_whatever_its_id() {
    for second_id in ["other", "same"] {
        let first_id = if second_id == "same" { "same" } else { "open" };
        let mut helper = HelperProcess::ready(std::process::id());
        helper.send(&start(first_id, CLIPBOARD));
        helper.send(&start(second_id, CLIPBOARD));
        // The first capture's three opening events and the refusal may interleave, so collect four.
        let events: Vec<_> = (0..4).map(|_| helper.event()).collect();
        let refusal = events.iter().find(|event| event["type"] == "error").expect("the second start is refused");
        assert_eq!(refusal["requestId"], second_id);
        assert_eq!((refusal["code"].as_str(), refusal["recoverable"].as_bool()), (Some("busy"), Some(true)));
        if second_id == "other" {
            assert_eq!(refusal["message"], "a screenshot interaction is already active");
        }
        assert!(events.iter().any(|event| event["type"] == "overlay-visible" && event["requestId"] == first_id));

        helper.send(&cancel(first_id));
        let cancelled = helper.event();
        assert_eq!((cancelled["type"].as_str(), cancelled["reason"].as_str()), (Some("cancelled"), Some("electron-cancelled")));
        helper.shut_down();
    }
}

#[test]
#[serial]
fn a_display_change_aborts_the_capture_and_a_new_one_starts_afresh() {
    let mut helper = HelperProcess::ready(std::process::id());
    helper.open_capture("moved-screens", CLIPBOARD);
    helper.post(WM_DISPLAYCHANGE, 32);
    let error = helper.event();
    assert_eq!(error["type"], "error");
    assert_eq!(error["requestId"], "moved-screens");
    assert_eq!((error["code"].as_str(), error["recoverable"].as_bool()), (Some("display-changed"), Some(true)));

    helper.open_capture("fresh-start", CLIPBOARD);
    helper.shut_down();
}
