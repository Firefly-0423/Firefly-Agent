//! Overlay HWND ownership and mouse/keyboard interaction.
use std::cell::RefCell;

use std::ptr::NonNull;

use windows::core::{
    w,
    PCWSTR,
    Error as WindowsError
};

use windows::Win32::{
    Foundation::{
        HWND,
        POINT,
        RECT,
        WPARAM,
        LPARAM,
        LRESULT
    },
    Graphics::{
        Gdi::{
            PAINTSTRUCT,
            BeginPaint,
            EndPaint,
            InvalidateRect
        },
        Dwm::{
            DwmGetWindowAttribute,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            DWMWA_CLOAKED
        },
    },
    UI::{
        Input::KeyboardAndMouse::{
            SetCapture,
            ReleaseCapture,
            SetFocus,
            GetKeyState,
            VK_ESCAPE,
            VK_RETURN,
            VK_CONTROL,
            VK_Z,
        },
        WindowsAndMessaging::{
            WNDCLASSW,
            CREATESTRUCTW,
            CS_DBLCLKS,
            CreateWindowExW,
            RegisterClassW,
            DestroyWindow,
            UnregisterClassW,
            LoadCursorW,
            IDC_CROSS,
            WS_POPUP,
            WS_EX_TOPMOST,
            WS_EX_TOOLWINDOW,
            SetWindowLongPtrW,
            GetWindowLongPtrW,
            GWLP_USERDATA,
            SetWindowPos,
            SWP_NOACTIVATE,
            SWP_NOOWNERZORDER,
            ShowWindow,
            SW_SHOW,
            SW_HIDE,
            SetForegroundWindow,
            IsWindowVisible,
            GetWindow,
            GW_HWNDNEXT,
            IsIconic,
            GetClassNameW,
            GetWindowRect,
            GetClientRect,
            DefWindowProcW,
            WM_CREATE,
            WM_NCDESTROY,
            WM_DESTROY,
            WM_PAINT,
            WM_LBUTTONDOWN,
            WM_LBUTTONUP,
            WM_LBUTTONDBLCLK,
            WM_RBUTTONDOWN,
            WM_MOUSEMOVE,
            WM_KEYDOWN,
            WM_COMMAND,
            WM_CAPTURECHANGED,
            WM_DISPLAYCHANGE,
            WM_DPICHANGED,
        },
    },
};

use crate::{
    error::HelperError,
    geometry::{
        AnnotationState,
        AnnotationTool,
        AnnotationColor,
        Mark,
        PointI,
        RectI,
        SelectionHandle,
        hit_test_selection_handle,
        resize_selection,
        localize_window_rect,
    },
    win::{
        display::DisplayInfo,
        renderer::{
            OverlayRenderer,
            ToolbarLayout,
            compute_toolbar
        }
    },
};

const WINDOW_CLASS: PCWSTR = w!("FireflyScreenshotOverlayWindow");

const HWND_TOPMOST: HWND = HWND(-1isize as *mut _);

pub const CMD_CONFIRM: usize = 1;

pub const CMD_CANCEL: usize = 2;

pub const TOOLBAR_WIDTH: u32 = 232;

pub const TOOLBAR_HEIGHT: u32 = 40;

pub const TOOLBAR_GAP: u32 = 8;

pub const TOOLBAR_BUTTON_GAP: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAction {
    Selected,
    Commit,
    Cancel,
    DisplayChanged,
}

#[derive(Debug, Clone, Copy)]
enum InputState {
    Idle,
    Selecting {
        anchor: POINT,
        candidate: Option<RectI>
    },
    Resizing {
        handle: SelectionHandle,
        original: RectI
    },
    Drawing {
        start: PointI
    },
    Selected,
}

struct OverlayState {
    monitor_area: RectI,
    monitor_dpi: f32,
    chosen: Option<RectI>,
    buttons: Option<ToolbarLayout>,
    edits: AnnotationState,
    preview: Option<Mark>,
    palette_open: bool,
    gesture: InputState,
    pending: Option<OverlayAction>,
    paint_failure: Option<String>,
    // Borrowed for one capture session; hide and detach end that session.
    painter: Option<NonNull<OverlayRenderer>>,
}

impl OverlayState {
    fn display(&self) -> DisplayInfo {
        DisplayInfo {
            bounds: self.monitor_area,
            dpi: self.monitor_dpi,
            rotation: crate::geometry::DisplayRotation::Identity,
            is_primary: true,
        }
    }
}

pub struct OverlayWindow {
    handle: HWND,
    data: NonNull<RefCell<OverlayState>>,
}

impl OverlayWindow {
    pub fn create(display: &DisplayInfo) -> Result<Self, HelperError> {
        let crosshair = unsafe {
            LoadCursorW(None, IDC_CROSS)
        }?;
        let registration = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            hCursor: crosshair,
            lpszClassName: WINDOW_CLASS,
            ..Default::default()
        };
        if unsafe {
            RegisterClassW(&registration)
        }
        == 0 {
            let failure = WindowsError::from_thread();
            if failure.code().0 != 0x8007_0582u32 as i32 {
                return Err(failure.into());
            }
        }
        let storage = Box::new(
            RefCell::new(
                OverlayState {
                    monitor_area: display.bounds,
                    monitor_dpi: display.dpi,
                    chosen: None,
                    buttons: None,
                    edits: AnnotationState::default(),
                    preview: None,
                    palette_open: false,
                    gesture: InputState::Idle,
                    pending: None,
                    paint_failure: None,
                    painter: None,
                }
            )
        );
        let data = NonNull::new(Box::into_raw(storage)).expect("Box pointer is never null");
        let desktop_area = display.bounds;
        let created = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                WINDOW_CLASS,
                w!(""),
                WS_POPUP,
                desktop_area.x,
                desktop_area.y,
                i32::try_from(desktop_area.width).map_err( |_| HelperError::InvalidDisplay("overlay width does not fit in i32".into()))?,
                i32::try_from(desktop_area.height).map_err( |_| HelperError::InvalidDisplay("overlay height does not fit in i32".into()))?,
                None,
                None,
                None,
                Some(data.as_ptr().cast())
            )
        };
        match created {
            Ok(handle) => Ok(Self {
                    handle,
                    data
            }),
            Err(failure) => {
                unsafe {
                    drop(Box::from_raw(data.as_ptr()));
                }
                unsafe {
                    _ = UnregisterClassW(WINDOW_CLASS, None);
                }
                Err(failure.into())
            }
        }
    }

    fn shared(&self) -> &RefCell<OverlayState> {
        unsafe {
            self.data.as_ref()
        }
    }
    /// The painter must stay alive until it is detached or this window is hidden.
    pub fn attach_renderer(&self, painter: &mut OverlayRenderer) {
        let mut view = self.shared().borrow_mut();
        view.paint_failure = None;
        view.painter = NonNull::new(painter as *mut OverlayRenderer);
    }

    pub fn detach_renderer(&self) {
        self.shared().borrow_mut().painter = None;
    }

    pub fn show(&self, display: &DisplayInfo) -> Result<(), HelperError> {
        self.set_fullscreen_bounds(display)?;
        unsafe {
            _ = ShowWindow(self.handle, SW_SHOW);
            _ = SetForegroundWindow(self.handle);
            _ = SetFocus(Some(self.handle));
        }
        Ok(())
    }

    pub fn hide(&self) -> Result<(), HelperError> {
        unsafe {
            _ = ShowWindow(self.handle, SW_HIDE);
        }
        let mut view = self.shared().borrow_mut();
        view.chosen = None;
        view.buttons = None;
        view.edits = AnnotationState::default();
        view.preview = None;
        view.palette_open = false;
        view.gesture = InputState::Idle;
        view.pending = None;
        view.paint_failure = None;
        view.painter = None;
        Ok(())
    }

    pub fn set_fullscreen_bounds(&self, display: &DisplayInfo) -> Result<(), HelperError> {
        let columns = i32::try_from(display.bounds.width).map_err( |_| HelperError::InvalidDisplay("overlay width does not fit in i32".into()))?;
        let rows = i32::try_from(display.bounds.height).map_err( |_| HelperError::InvalidDisplay("overlay height does not fit in i32".into()))?;
        unsafe {
            SetWindowPos(
                self.handle,
                Some(HWND_TOPMOST),
                display.bounds.x,
                display.bounds.y,
                columns,
                rows,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER
            )?;
        }
        let mut view = self.shared().borrow_mut();
        view.monitor_area = display.bounds;
        view.monitor_dpi = display.dpi;
        Ok(())
    }

    pub fn is_visible(&self) -> bool {
        unsafe {
            IsWindowVisible(self.handle).as_bool()
        }
    }

    pub fn take_action(&self) -> Option<OverlayAction> {
        self.shared().borrow_mut().pending.take()
    }

    pub fn take_paint_error(&self) -> Option<HelperError> {
        let mut view = self.shared().borrow_mut();
        view.paint_failure.take().map(HelperError::CaptureFailed)
    }

    pub fn selection(&self) -> Option<RectI> {
        self.shared().borrow().chosen
    }

    pub fn toolbar(&self) -> Option<ToolbarLayout> {
        self.shared().borrow().buttons
    }

    pub fn annotations(&self) -> Vec<Mark> {
        self.shared().borrow().edits.marks().to_vec()
    }

    pub fn hwnd(&self) -> HWND {
        self.handle
    }
}

impl Drop for OverlayWindow {
    fn drop(&mut self) {
        unsafe {
            _ = DestroyWindow(self.handle);
            drop(Box::from_raw(self.data.as_ptr()));
            _ = UnregisterClassW(WINDOW_CLASS, None);
        }
    }
}
unsafe extern "system" fn window_proc(handle: HWND, kind: u32, word: WPARAM, packed: LPARAM) -> LRESULT {
    if kind == WM_CREATE {
        let supplied = unsafe {
            &*(packed.0 as *const CREATESTRUCTW)
        };
        unsafe {
            SetWindowLongPtrW(handle, GWLP_USERDATA, supplied.lpCreateParams as isize);
        }
        return LRESULT(0);
    }
    let pointer = unsafe {
        GetWindowLongPtrW(handle, GWLP_USERDATA)
    }
    as *mut RefCell<OverlayState>;
    if pointer.is_null() {
        return unsafe {
            DefWindowProcW(handle, kind, word, packed)
        };
    }
    let shared = unsafe {
        &*pointer
    };
    match kind {
        WM_LBUTTONDOWN => mouse_press(shared, handle, packed),
        WM_MOUSEMOVE => mouse_motion(shared, handle, packed),
        WM_LBUTTONUP => mouse_release(shared, handle, packed),
        WM_RBUTTONDOWN => {
            let cursor = clamp_client_point(handle, point_from_lparam(packed));
            let mut view = shared.borrow_mut();
            if view.buttons.is_some_and(|panel| contains(panel.undo, cursor)) {
                view.edits.clear();
                view.preview = None;
                invalidate_all(handle);
            }
        }
        WM_LBUTTONDBLCLK => {
            let mut view = shared.borrow_mut();
            if view.chosen.is_some_and(|area| contains(area, point_from_lparam(packed))) {
                view.pending = Some(OverlayAction::Commit);
            }
        }
        WM_KEYDOWN if word.0 == VK_ESCAPE.0 as usize => {
            shared.borrow_mut().pending = Some(OverlayAction::Cancel);
        }
        WM_KEYDOWN if word.0 == VK_RETURN.0 as usize => {
            let mut view = shared.borrow_mut();
            if view.chosen.is_some() {
                view.pending = Some(OverlayAction::Commit);
            }
        }
        WM_KEYDOWN if word.0 == VK_Z.0 as usize && unsafe {
            GetKeyState(VK_CONTROL.0 as i32)
        }
        < 0 => {
            let mut view = shared.borrow_mut();
            view.edits.undo();
            view.preview = None;
            invalidate_all(handle);
        }
        WM_COMMAND => {
            let identifier = word.0 & 0xffff;
            let mut view = shared.borrow_mut();
            if identifier == CMD_CONFIRM && view.chosen.is_some() {
                view.pending = Some(OverlayAction::Commit);
            } else if identifier == CMD_CANCEL {
                view.pending = Some(OverlayAction::Cancel);
            }
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            if unsafe {
                IsWindowVisible(handle).as_bool()
            }
            {
                shared.borrow_mut().pending = Some(OverlayAction::DisplayChanged);
            }
        }
        WM_CAPTURECHANGED => {
            let mut view = shared.borrow_mut();
            if matches!(
                view.gesture,
                InputState::Selecting {
                    ..
                } | InputState::Resizing {
                    ..
                } | InputState::Drawing {
                    ..
                }
            ) {
                view.gesture = InputState::Idle;
                view.preview = None;
            }
        }
        WM_PAINT => paint_overlay(shared, handle),
        WM_NCDESTROY | WM_DESTROY => {
            unsafe {
                SetWindowLongPtrW(handle, GWLP_USERDATA, 0);
            }
            return unsafe {
                DefWindowProcW(handle, kind, word, packed)
            };
        }
        _ => return unsafe {
            DefWindowProcW(handle, kind, word, packed)
        },
    }
    LRESULT(0)
}

fn invalidate_all(handle: HWND) {
    unsafe {
        _ = InvalidateRect(Some(handle), None, false);
    }
}

fn toolbar_press(view: &mut OverlayState, handle: HWND, panel: ToolbarLayout, cursor: POINT) -> bool {
    if contains(panel.rectangle, cursor) {
        view.edits.tool = Some(AnnotationTool::Rectangle);
        view.palette_open = true;
        invalidate_all(handle);
        return true;
    }
    if contains(panel.arrow, cursor) {
        view.edits.tool = Some(AnnotationTool::Arrow);
        view.palette_open = true;
        invalidate_all(handle);
        return true;
    }
    if contains(panel.undo, cursor) {
        view.edits.undo();
        invalidate_all(handle);
        return true;
    }
    if contains(panel.confirm, cursor) {
        view.pending = Some(OverlayAction::Commit);
        return true;
    }
    if contains(panel.cancel, cursor) {
        view.pending = Some(OverlayAction::Cancel);
        return true;
    }
    if view.palette_open {
        if let Some(ordinal) = panel.colors.iter().position(|area| contains(*area, cursor)) {
            view.edits.color = annotation_color(ordinal);
            view.palette_open = false;
            invalidate_all(handle);
            return true;
        }
    }
    false
}

fn mouse_press(shared: &RefCell<OverlayState>, handle: HWND, packed: LPARAM) {
    let cursor = clamp_client_point(handle, point_from_lparam(packed));
    let mut view = shared.borrow_mut();
    if matches!(view.gesture, InputState::Selected) {
        if let Some(panel) = view.buttons {
            if toolbar_press(&mut view, handle, panel, cursor) {
                return;
            }
        }
    }
    if matches!(view.gesture, InputState::Selected) {
        if let Some(chosen) = view.chosen {
            let local = PointI {
                x: cursor.x,
                y: cursor.y
            };
            if let Some(edge) = hit_test_selection_handle(chosen, local, 10) {
                view.edits.clear();
                view.preview = None;
                view.palette_open = false;
                view.buttons = None;
                view.gesture = InputState::Resizing {
                    handle: edge,
                    original: chosen
                };
                // SetCapture can synchronously deliver another window message.
                drop(view);
                unsafe {
                    SetCapture(handle);
                }
                return;
            }
            if view.edits.tool.is_some() && contains(chosen, cursor) {
                view.preview = make_mark(view.edits.tool, local, local, view.edits.color);
                view.gesture = InputState::Drawing {
                    start: local
                };
                drop(view);
                unsafe {
                    SetCapture(handle);
                }
                return;
            }
        }
    }
    let hovered = find_top_level_window_at_point(handle, cursor, view.monitor_area);
    view.edits.clear();
    view.preview = None;
    view.palette_open = false;
    view.buttons = None;
    view.gesture = InputState::Selecting {
        anchor: cursor,
        candidate: hovered
    };
    drop(view);
    unsafe {
        SetCapture(handle);
    }
}

fn mouse_motion(shared: &RefCell<OverlayState>, handle: HWND, packed: LPARAM) {
    let cursor = clamp_client_point(handle, point_from_lparam(packed));
    let mut view = shared.borrow_mut();
    let gesture = view.gesture;
    let old_chosen = view.chosen;
    let old_buttons = view.buttons;
    let old_preview = view.preview;
    match view.gesture {
        InputState::Idle => {
            view.chosen = find_top_level_window_at_point(handle, cursor, view.monitor_area);
        }
        InputState::Selecting {
            anchor: origin,
            candidate: hovered
        } => {
            view.chosen = if drag_distance(origin, cursor) >= 4 {
                normalized_rect(origin, cursor)
            } else {
                hovered
            };
            view.buttons = None;
        }
        InputState::Resizing {
            handle: edge,
            original: initial
        } => {
            let viewport = RectI {
                x: 0,
                y: 0,
                width: view.monitor_area.width,
                height: view.monitor_area.height
            };
            if let Some(adjusted) = resize_selection(initial, edge, PointI {
                    x: cursor.x,
                    y: cursor.y
                }, viewport, 4) {
                view.chosen = Some(adjusted);
            }
        }
        InputState::Drawing {
            start: origin
        } => {
            if let Some(chosen) = view.chosen {
                let endpoint = clamp_point_to_rect(PointI {
                        x: cursor.x,
                        y: cursor.y
                    }, chosen);
                view.preview = make_mark(view.edits.tool, origin, endpoint, view.edits.color);
            }
        }
        InputState::Selected => {
        }
    }
    let changed = view.chosen != old_chosen || view.buttons != old_buttons || view.preview != old_preview;
    let invalid_area = if matches!(gesture, InputState::Drawing {
            ..
    }) {
        draft_repaint_region(
            old_preview,
            view.preview,
            RectI {
                x: 0,
                y: 0,
                width: view.monitor_area.width,
                height: view.monitor_area.height
            },
            16
        )
    } else {
        None
    };
    let redraw = mouse_move_requires_repaint(&gesture, changed);
    drop(view);
    if redraw {
        match invalid_area {
            Some(area) => {
                let raw_area = RECT {
                    left: area.x,
                    top: area.y,
                    right: area.x.saturating_add_unsigned(area.width),
                    bottom: area.y.saturating_add_unsigned(area.height)
                };
                unsafe {
                    _ = InvalidateRect(Some(handle), Some(&raw_area), false);
                }
            }
            None => invalidate_all(handle),
        }
    }
}

fn mouse_release(shared: &RefCell<OverlayState>, handle: HWND, packed: LPARAM) {
    let ready = {
        let mut view = shared.borrow_mut();
        let mut changed = false;
        let cursor = clamp_client_point(handle, point_from_lparam(packed));
        match view.gesture {
            InputState::Selecting {
                anchor: origin,
                candidate: hovered
            } => {
                let chosen = if drag_distance(origin, cursor) >= 4 {
                    normalized_rect(origin, cursor)
                } else {
                    hovered
                }.filter(|area| area.width >= 4 && area.height >= 4);
                view.chosen = chosen;
                match chosen {
                    Some(area) => {
                        view.buttons = toolbar_for_state(&view, area);
                        view.gesture = InputState::Selected;
                        view.pending = Some(OverlayAction::Selected);
                        changed = true;
                    }
                    None => {
                        view.buttons = None;
                        view.gesture = InputState::Idle;
                    }
                }
            }
            InputState::Resizing {
                ..
            } => {
                if let Some(area) = view.chosen {
                    view.buttons = toolbar_for_state(&view, area);
                    view.gesture = InputState::Selected;
                    view.pending = Some(OverlayAction::Selected);
                    changed = true;
                }
            }
            InputState::Drawing {
                ..
            } => {
                if let Some(annotation) = view.preview.take() {
                    if mark_size(annotation) >= 4 {
                        view.edits.push(annotation);
                    }
                }
                view.gesture = InputState::Selected;
                changed = true;
            }
            InputState::Idle | InputState::Selected => {
            }
        }
        changed
    };
    unsafe {
        _ = ReleaseCapture();
    }
    if ready {
        invalidate_all(handle);
    }
}

fn paint_overlay(shared: &RefCell<OverlayState>, handle: HWND) {
    let mut update = PAINTSTRUCT::default();
    let destination = unsafe {
        BeginPaint(handle, &mut update)
    };
    {
        let mut view = shared.borrow_mut();
        let monitor = view.display();
        if let Some(attached) = view.painter {
            // Only a shared painter reference spans this callback.
            let painter = unsafe {
                &*attached.as_ptr()
            };
            let painted = painter.paint_on_hdc(
                destination,
                handle,
                view.chosen,
                &monitor,
                view.buttons,
                view.edits.marks(),
                view.preview,
                view.palette_open,
                view.edits.tool,
                view.edits.color
            );
            if let Err(error) = painted {
                eprintln!("firefly-screenshot: overlay paint failed: {error}");
                view.paint_failure = Some(error.to_string());
            }
        } else {
            _ = crate::win::renderer::paint_hdc(destination, view.chosen, &monitor);
        }
    }
    unsafe {
        _ = EndPaint(handle, &update);
    }
}

fn point_from_lparam(packed: LPARAM) -> POINT {
    let horizontal = (packed.0 as u16) as i16 as i32;
    let vertical = ((packed.0 as u32 >> 16) as u16) as i16 as i32;
    POINT {
        x: horizontal,
        y: vertical
    }
}

fn clamp_client_point(handle: HWND, cursor: POINT) -> POINT {
    let mut viewport = RECT::default();
    unsafe {
        _ = GetClientRect(handle, &mut viewport);
    }
    POINT {
        x: cursor.x.clamp(viewport.left, viewport.right),
        y: cursor.y.clamp(viewport.top, viewport.bottom)
    }
}

fn normalized_rect(from: POINT, to: POINT) -> Option<RectI> {
    let min_x = from.x.min(to.x);
    let min_y = from.y.min(to.y);
    let columns = u32::try_from((i64::from(from.x) - i64::from(to.x)).abs()).ok()?;
    let rows = u32::try_from((i64::from(from.y) - i64::from(to.y)).abs()).ok()?;
    Some(RectI {
            x: min_x,
            y: min_y,
            width: columns,
            height: rows
    })
}

fn contains(area: RectI, cursor: POINT) -> bool {
    point_in_screen_rect(area, PointI {
            x: cursor.x,
            y: cursor.y
    })
}

fn toolbar_for_state(view: &OverlayState, chosen: RectI) -> Option<ToolbarLayout> {
    compute_toolbar(chosen, &view.display())
}

fn annotation_color(ordinal: usize) -> AnnotationColor {
    match ordinal {
        1 => AnnotationColor::Yellow,
        2 => AnnotationColor::Green,
        3 => AnnotationColor::Blue,
        _ => AnnotationColor::Red,
    }
}

fn make_mark(
    selected_tool: Option<AnnotationTool>,
    from: PointI,
    to: PointI,
    hue: AnnotationColor
) -> Option<Mark> {
    selected_tool.map(
        |tool| match tool {
            AnnotationTool::Rectangle => Mark::Rect {
                start: from,
                end: to,
                color: hue
            },
            AnnotationTool::Arrow => Mark::Arrow {
                start: from,
                end: to,
                color: hue
            },
        }
    )
}

fn mark_size(annotation: Mark) -> i32 {
    let (from, to) = match annotation {
        Mark::Rect {
            start: from,
            end: to,
            ..
        } | Mark::Arrow {
            start: from,
            end: to,
            ..
        } => (from, to),
    };
    (from.x - to.x).abs().max((from.y - to.y).abs())
}

fn clamp_point_to_rect(cursor: PointI, area: RectI) -> PointI {
    PointI {
        x: cursor.x.clamp(area.x, area.x.saturating_add_unsigned(area.width)),
        y: cursor.y.clamp(area.y, area.y.saturating_add_unsigned(area.height))
    }
}

fn drag_distance(from: POINT, to: POINT) -> i32 {
    (from.x - to.x).abs().max((from.y - to.y).abs())
}

fn mouse_move_requires_repaint(gesture: &InputState, changed: bool) -> bool {
    if matches!(gesture, InputState::Selecting {
            ..
        } | InputState::Resizing {
            ..
    }) {
        true
    } else {
        changed
    }
}

fn draft_repaint_region(
    old_preview: Option<Mark>,
    new_preview: Option<Mark>,
    viewport: RectI,
    margin: i32
) -> Option<RectI> {
    let mut previews = old_preview.into_iter().chain(new_preview);
    let initial = previews.next()?;
    let (mut min_x, mut min_y, mut max_x, mut max_y) = mark_bounds(initial);
    for annotation in previews {
        let (next_min_x, next_min_y, next_max_x, next_max_y) = mark_bounds(annotation);
        min_x = min_x.min(next_min_x);
        min_y = min_y.min(next_min_y);
        max_x = max_x.max(next_max_x);
        max_y = max_y.max(next_max_y);
    }
    let limit_x = viewport.x.saturating_add_unsigned(viewport.width);
    let limit_y = viewport.y.saturating_add_unsigned(viewport.height);
    min_x = min_x.saturating_sub(margin).clamp(viewport.x, limit_x);
    min_y = min_y.saturating_sub(margin).clamp(viewport.y, limit_y);
    max_x = max_x.saturating_add(margin).clamp(viewport.x, limit_x);
    max_y = max_y.saturating_add(margin).clamp(viewport.y, limit_y);
    (max_x > min_x && max_y > min_y).then_some(
        RectI {
            x: min_x,
            y: min_y,
            width: u32::try_from(max_x - min_x).ok()?,
            height: u32::try_from(max_y - min_y).ok()?,
        }
    )
}

fn mark_bounds(annotation: Mark) -> (i32, i32, i32, i32) {
    let (from, to) = match annotation {
        Mark::Rect {
            start: from,
            end: to,
            ..
        } | Mark::Arrow {
            start: from,
            end: to,
            ..
        } => (from, to),
    };
    (from.x.min(to.x), from.y.min(to.y), from.x.max(to.x), from.y.max(to.y))
}

fn find_top_level_window_at_point(overlay_handle: HWND, cursor: POINT, monitor_area: RectI) -> Option<RectI> {
    let desktop_cursor = PointI {
        x: cursor.x.checked_add(monitor_area.x)?,
        y: cursor.y.checked_add(monitor_area.y)?,
    };
    let mut inspected = unsafe {
        GetWindow(overlay_handle, GW_HWNDNEXT)
    }.ok()?;
    loop {
        let eligible = unsafe {
            IsWindowVisible(inspected).as_bool()
        }
        && !unsafe {
            IsIconic(inspected).as_bool()
        }
        && !is_shell_window(inspected) && !is_cloaked(inspected);
        if eligible {
            if let Some(desktop_area) = visible_window_rect(inspected) {
                if point_in_screen_rect(desktop_area, desktop_cursor) {
                    return localize_window_rect(desktop_area, monitor_area);
                }
            }
        }
        inspected = unsafe {
            GetWindow(inspected, GW_HWNDNEXT)
        }.ok()?;
    }
}

fn visible_window_rect(handle: HWND) -> Option<RectI> {
    let mut desktop_area = RECT::default();
    let queried = unsafe {
        DwmGetWindowAttribute(
            handle,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut desktop_area as *mut RECT).cast(),
            u32::try_from(std::mem::size_of::<RECT>()).ok()?
        )
    };
    if queried.is_err() {
        unsafe {
            GetWindowRect(handle, &mut desktop_area)
        }.ok()?;
    }
    let columns = u32::try_from(i64::from(desktop_area.right) - i64::from(desktop_area.left)).ok()?;
    let rows = u32::try_from(i64::from(desktop_area.bottom) - i64::from(desktop_area.top)).ok()?;
    (columns > 0 && rows > 0).then_some(
        RectI {
            x: desktop_area.left,
            y: desktop_area.top,
            width: columns,
            height: rows,
        }
    )
}

fn point_in_screen_rect(area: RectI, cursor: PointI) -> bool {
    i64::from(cursor.x) >= i64::from(area.x) && i64::from(cursor.y) >= i64::from(area.y) && i64::from(cursor.x) < i64::from(area.x) + i64::from(area.width) && i64::from(cursor.y) < i64::from(area.y) + i64::from(area.height)
}

fn is_cloaked(handle: HWND) -> bool {
    let mut flag = 0u32;
    let queried = unsafe {
        DwmGetWindowAttribute(
            handle,
            DWMWA_CLOAKED,
            (&mut flag as *mut u32).cast(),
            u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4)
        )
    };
    queried.is_ok() && flag != 0
}

fn is_shell_window(handle: HWND) -> bool {
    let mut class_name = [0u16; 64];
    let used = unsafe {
        GetClassNameW(handle, &mut class_name)
    };
    if used <= 0 {
        return false;
    }
    let decoded = String::from_utf16_lossy(&class_name[..used as usize]);
    matches!(decoded.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd")
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_mouse_move_without_visual_change_does_not_request_repaint() {
        assert!(!mouse_move_requires_repaint(&InputState::Selected, false));
    }

    #[test]
    fn drawing_repaint_region_covers_previous_and_current_marks_only() {
        let previous = Mark::Rect {
            start: PointI { x: 30, y: 30 },
            end: PointI { x: 40, y: 40 },
            color: AnnotationColor::Red,
        };
        let current = Mark::Arrow {
            start: PointI { x: 30, y: 30 },
            end: PointI { x: 60, y: 50 },
            color: AnnotationColor::Red,
        };

        assert_eq!(
            draft_repaint_region(
                Some(previous),
                Some(current),
                RectI {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 80,
                },
                16,
            ),
            Some(RectI {
                x: 14,
                y: 14,
                width: 62,
                height: 52,
            })
        );
    }
}
