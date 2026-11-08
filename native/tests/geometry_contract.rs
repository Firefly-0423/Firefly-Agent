//! Pure geometry the overlay relies on: rotating a capture region, placing the toolbar, localizing a window,
//! grabbing and dragging selection handles, and the annotation history.

use firefly_screenshot::geometry::{
    AnnotationColor, AnnotationState, AnnotationTool, DisplayRotation, Mark, PointI, RectI, SelectionHandle, hit_test_selection_handle,
    localize_window_rect, place_toolbar, resize_selection, rotate_rect_to_display,
};

const fn rect(x: i32, y: i32, width: u32, height: u32) -> RectI {
    RectI { x, y, width, height }
}

const fn at(x: i32, y: i32) -> PointI {
    PointI { x, y }
}

/// A 200×120 source texture; region spans x 30..70 and y 20..70.
const REGION: RectI = rect(30, 20, 40, 50);

#[test]
fn a_region_maps_into_each_display_orientation() {
    let expected = [
        (DisplayRotation::Identity, rect(30, 20, 40, 50)),
        // A quarter turn swaps the axes: x comes from the distance to the bottom edge.
        (DisplayRotation::Rotate90, rect(50, 30, 50, 40)),
        (DisplayRotation::Rotate180, rect(130, 50, 40, 50)),
        (DisplayRotation::Rotate270, rect(20, 130, 50, 40)),
    ];
    for (rotation, mapped) in expected {
        assert_eq!(rotate_rect_to_display(REGION, 200, 120, rotation), Some(mapped), "{rotation:?}");
    }
}

#[test]
fn a_region_is_clipped_to_the_texture_and_dropped_when_under_four_pixels() {
    assert_eq!(rotate_rect_to_display(rect(-10, 100, 30, 40), 200, 120, DisplayRotation::Identity), Some(rect(0, 100, 20, 20)));
    // Only 3 columns remain inside the texture.
    assert_eq!(rotate_rect_to_display(rect(197, 0, 10, 10), 200, 120, DisplayRotation::Identity), None);
}

#[test]
fn the_toolbar_goes_below_then_above_then_inside_the_selection() {
    let screen = rect(0, 0, 300, 200);
    let place = |selection| place_toolbar(selection, screen, 60, 12, 6);
    assert_eq!(place(rect(100, 50, 80, 40)), Some(rect(110, 96, 60, 12)), "room below");
    assert_eq!(place(rect(100, 150, 80, 45)), Some(rect(110, 132, 60, 12)), "no room below");
    assert_eq!(place(rect(100, 5, 80, 190)), Some(rect(110, 183, 60, 12)), "no room outside");
    assert_eq!(place(rect(0, 50, 20, 20)), Some(rect(0, 76, 60, 12)), "kept on screen horizontally");
}

#[test]
fn there_is_no_toolbar_for_an_empty_screen_or_a_toolbar_wider_than_it() {
    assert_eq!(place_toolbar(rect(0, 0, 10, 10), rect(0, 0, 0, 50), 8, 8, 1), None);
    assert_eq!(place_toolbar(rect(0, 0, 10, 10), rect(0, 0, 50, 50), 51, 8, 1), None);
}

#[test]
fn a_window_is_cut_to_its_display_and_given_display_coordinates() {
    assert_eq!(localize_window_rect(rect(250, 90, 100, 60), rect(200, 100, 120, 80)), Some(rect(50, 0, 70, 50)));
}

#[test]
fn handles_sit_on_the_corners_and_edge_midpoints() {
    // Columns 40/90/140 and rows 40/70/100; a 10-pixel handle reaches 5 pixels around each.
    let selection = rect(40, 40, 100, 60);
    let grab = |x, y| hit_test_selection_handle(selection, at(x, y), 10);
    assert_eq!(grab(143, 98), Some(SelectionHandle::BottomRight));
    assert_eq!(grab(38, 72), Some(SelectionHandle::Left));
    assert_eq!(grab(90, 36), Some(SelectionHandle::Top));
    assert_eq!(grab(90, 70), None, "the middle of the selection is not a handle");
    assert_eq!(hit_test_selection_handle(selection, at(40, 40), 0), None, "zero-size handles never match");
}

#[test]
fn dragging_a_handle_stays_in_bounds_flips_past_the_far_edge_and_keeps_a_minimum() {
    let selection = rect(50, 50, 100, 80);
    let bounds = rect(0, 0, 300, 200);
    let drag = |handle, x, y| resize_selection(selection, handle, at(x, y), bounds, 4);
    assert_eq!(drag(SelectionHandle::BottomRight, 400, 260), Some(rect(50, 50, 250, 150)));
    assert_eq!(drag(SelectionHandle::Left, 200, 90), Some(rect(150, 50, 50, 80)));
    assert_eq!(drag(SelectionHandle::Right, 52, 90), None);
}

#[test]
fn undo_takes_back_the_latest_mark_and_clear_empties_the_history() {
    let mut history = AnnotationState::default();
    assert!(history.undo().is_none(), "nothing to undo yet");
    history.push(Mark { tool: AnnotationTool::Arrow, start: at(5, 5), end: at(60, 30), color: AnnotationColor::Yellow });
    history.push(Mark { tool: AnnotationTool::Rectangle, start: at(10, 40), end: at(70, 90), color: AnnotationColor::Red });
    assert!(matches!(history.undo(), Some(Mark { tool: AnnotationTool::Rectangle, .. })));
    assert_eq!(history.len(), 1);
    history.clear();
    assert!(history.is_empty());
}
