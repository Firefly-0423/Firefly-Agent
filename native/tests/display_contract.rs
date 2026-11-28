//! What the helper learns about the primary display before it freezes the desktop.
#![cfg(windows)]

use firefly_screenshot::geometry::DisplayRotation;
use firefly_screenshot::win::display::{query_primary_display, set_dpi_awareness};

#[test]
fn per_monitor_dpi_awareness_can_be_requested_more_than_once() {
    for attempt in 1..=2 {
        assert!(set_dpi_awareness().is_ok(), "DPI awareness request {attempt} failed");
    }
}

#[test]
fn the_primary_display_has_a_usable_size_scale_and_orientation() {
    let display = query_primary_display().expect("the primary display can be queried");
    assert!(display.is_primary, "the query returns the primary display");
    assert!(display.bounds.width > 0 && display.bounds.height > 0, "empty bounds: {:?}", display.bounds);
    assert!(display.dpi > 0.0, "non-positive DPI: {}", display.dpi);
    assert!(
        matches!(
            display.rotation,
            DisplayRotation::Identity | DisplayRotation::Rotate90 | DisplayRotation::Rotate180 | DisplayRotation::Rotate270
        ),
        "unexpected rotation {:?}",
        display.rotation
    );
}
