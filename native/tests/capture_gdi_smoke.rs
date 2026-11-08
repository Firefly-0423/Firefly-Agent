//! The GDI fallback backend on the real primary display.
#![cfg(windows)]

use firefly_screenshot::error::HelperError;
use firefly_screenshot::geometry::{DisplayRotation, RectI};
use firefly_screenshot::win::capture::{CaptureBackend, CpuBgraFrame, FrozenFrame, RefreshOutcome};
use firefly_screenshot::win::capture_gdi::GdiCaptureBackend;
use firefly_screenshot::win::display::{DisplayInfo, query_primary_display, set_dpi_awareness};

fn backend() -> GdiCaptureBackend {
    GdiCaptureBackend::new().expect("the GDI backend starts")
}

fn primary() -> DisplayInfo {
    set_dpi_awareness().expect("DPI awareness is set before capturing");
    query_primary_display().expect("the primary display can be queried")
}

#[test]
fn freezing_copies_the_whole_display_in_its_upright_size() {
    // Whatever rotation Windows reports, the frozen frame has the display's own width and height,
    // so the overlay can draw it without turning it.
    let display = primary();
    let FrozenFrame::Cpu(CpuBgraFrame { width, height, pitch, pixels }) = backend().freeze(&display).expect("freeze succeeds") else {
        panic!("the GDI backend freezes into CPU memory");
    };
    assert_eq!((width, height), (display.bounds.width, display.bounds.height));
    assert!(pitch >= width.saturating_mul(4), "a row of {width} BGRA pixels needs at least {} bytes, pitch is {pitch}", width * 4);
    assert!(!pixels.is_empty() && pixels.len() >= pitch as usize * height as usize, "{} bytes for {height} rows of {pitch}", pixels.len());
}

#[test]
fn gdi_never_pushes_frames_even_after_being_invalidated() {
    // GDI copies the screen on demand, so there is never a newer frame waiting.
    let mut gdi = backend();
    assert_eq!(gdi.refresh_latest(0).expect("refresh"), RefreshOutcome::Unchanged);
    gdi.invalidate();
    assert_eq!(gdi.refresh_latest(0).expect("refresh after invalidate"), RefreshOutcome::Unchanged);
}

#[test]
fn a_display_too_large_to_buffer_is_an_error_not_a_crash() {
    let _ = primary();
    let absurd = DisplayInfo {
        bounds: RectI { x: 0, y: 0, width: i32::MAX as u32, height: i32::MAX as u32 },
        dpi: 96.0,
        rotation: DisplayRotation::Identity,
        is_primary: true,
    };
    let failure = backend().freeze(&absurd).expect_err("an impossible buffer size is refused");
    assert!(matches!(failure, HelperError::InvalidDisplay(_)), "got {failure:?}");
}
