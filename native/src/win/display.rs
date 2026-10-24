use windows::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::{
        DEVMODEW, DEVMODE_DISPLAY_ORIENTATION, DMDO_90, DMDO_180, DMDO_270,
        EDS_ROTATEDMODE, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsExW, GetDC,
        GetDeviceCaps, GetMonitorInfoW, LOGPIXELSX, MONITORINFO,
        MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint, ReleaseDC,
    },
    System::Threading::GetCurrentProcess,
    UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, DPI_AWARENESS_CONTEXT,
        SetProcessDpiAwarenessContext, GetDpiAwarenessContextForProcess, AreDpiAwarenessContextsEqual,
    },
};
use crate::{error::HelperError, geometry::{DisplayRotation, RectI}};

#[derive(Debug, Clone)]
pub struct DisplayInfo {
    pub bounds: RectI,
    pub dpi: f32,
    /// Orientation reported for the physical panel.
    pub rotation: DisplayRotation,
    pub is_primary: bool,
}

pub fn set_dpi_awareness() -> Result<(), HelperError> {
    // SAFETY: The SDK context constant requires no backing allocation.
    match unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } {
        Ok(()) => Ok(()),
        Err(set_failure) => {
            let actual = current_process_awareness_context();
            // SAFETY: Both values are system-defined awareness contexts.
            if unsafe { AreDpiAwarenessContextsEqual(actual, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.as_bool() {
                Ok(())
            } else {
                Err(set_failure.into())
            }
        }
    }
}

#[inline]
fn current_process_awareness_context() -> DPI_AWARENESS_CONTEXT {
    // SAFETY: The process pseudo-handle stays valid and is not owned.
    unsafe { GetDpiAwarenessContextForProcess(GetCurrentProcess()) }
}

pub fn query_primary_display() -> Result<DisplayInfo, HelperError> {
    // SAFETY: The query accepts coordinates by value.
    let primary = unsafe { MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY) };
    if primary.is_invalid() {
        return Err(HelperError::DisplayQueryFailed(String::from("MonitorFromPoint returned an invalid handle")));
    }
    let mut details = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..MONITORINFO::default()
    };
    // SAFETY: The sized output record is writable for the entire call.
    if !unsafe { GetMonitorInfoW(primary, &mut details) }.as_bool() {
        return Err(HelperError::DisplayQueryFailed(format!(
            "GetMonitorInfoW returned 0 (last error: {})", windows::core::Error::from_thread().message()
        )));
    }
    let physical_bounds = monitor_bounds(&details)?;
    let logical_dpi = dpi_from_desktop()?;
    let panel_rotation = current_rotation()?;
    let primary_flag = details.dwFlags & MONITORINFO_PRIMARY != 0;
    Ok(DisplayInfo {
        bounds: physical_bounds, dpi: logical_dpi, rotation: panel_rotation, is_primary: primary_flag,
    })
}

const MONITORINFO_PRIMARY: u32 = 1;

fn monitor_bounds(details: &MONITORINFO) -> Result<RectI, HelperError> {
    let area = details.rcMonitor;
    let horizontal = u32::try_from(area.right - area.left).map_err(|_| HelperError::InvalidDisplay(format!(
        "monitor bounds width was negative (left={}, right={})", area.left, area.right
    )))?;
    let vertical = u32::try_from(area.bottom - area.top).map_err(|_| HelperError::InvalidDisplay(format!(
        "monitor bounds height was negative (top={}, bottom={})", area.top, area.bottom
    )))?;
    Ok(RectI { x: area.left, y: area.top, width: horizontal, height: vertical })
}

fn dpi_from_desktop() -> Result<f32, HelperError> {
    // SAFETY: None selects the desktop; this function releases the returned DC.
    let desktop = unsafe { GetDC(None) };
    if desktop.is_invalid() {
        return Err(HelperError::DisplayQueryFailed(format!(
            "GetDC returned an invalid handle (last error: {})", windows::core::Error::from_thread().message()
        )));
    }
    // SAFETY: desktop is held until after the capability query finishes.
    let horizontal_dpi = unsafe { GetDeviceCaps(Some(desktop), LOGPIXELSX) };
    let _ = unsafe { ReleaseDC(Some(HWND(std::ptr::null_mut())), desktop) };
    match horizontal_dpi {
        ..=0 => Err(HelperError::DisplayQueryFailed(format!(
            "GetDeviceCaps(LOGPIXELSX) returned a non-positive value: {horizontal_dpi}"
        ))),
        positive => Ok(positive as f32),
    }
}

fn current_rotation() -> Result<DisplayRotation, HelperError> {
    let mut settings = DEVMODEW {
        dmSize: size_of::<DEVMODEW>() as u16,
        ..DEVMODEW::default()
    };
    // SAFETY: settings has the required size; None selects the primary device.
    if !unsafe { EnumDisplaySettingsExW(None, ENUM_CURRENT_SETTINGS, &mut settings, EDS_ROTATEDMODE) }.as_bool() {
        return Err(HelperError::DisplayQueryFailed(format!(
            "EnumDisplaySettingsExW returned 0 (last error: {})", windows::core::Error::from_thread().message()
        )));
    }
    // SAFETY: The display settings API populated the display branch of the union.
    Ok(orientation_from_devmode(unsafe { settings.Anonymous1.Anonymous2.dmDisplayOrientation }))
}

#[inline]
fn orientation_from_devmode(orientation: DEVMODE_DISPLAY_ORIENTATION) -> DisplayRotation {
    match orientation {
        DMDO_90 => DisplayRotation::Rotate90,
        DMDO_180 => DisplayRotation::Rotate180,
        DMDO_270 => DisplayRotation::Rotate270,
        _ => DisplayRotation::Identity,
    }
}

#[cfg(test)]
mod tests {
    use super::{orientation_from_devmode, set_dpi_awareness};
    use crate::geometry::DisplayRotation;
    use windows::Win32::Graphics::Gdi::{DMDO_DEFAULT, DMDO_270, DMDO_180, DMDO_90};

    #[test]
    fn orientation_default_is_identity() {
        let actual = orientation_from_devmode(DMDO_DEFAULT);
        assert_eq!(actual, DisplayRotation::Identity);
    }

    #[test]
    fn orientation_known_constants_map_to_canonical_rotations() {
        for (native, expected) in [
            (DMDO_90, DisplayRotation::Rotate90),
            (DMDO_180, DisplayRotation::Rotate180),
            (DMDO_270, DisplayRotation::Rotate270),
        ] {
            let actual = orientation_from_devmode(native);
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn set_dpi_awareness_is_idempotent_in_process() {
        for expectation in ["first call must succeed", "second call must succeed"] {
            set_dpi_awareness().expect(expectation);
        }
    }
}
