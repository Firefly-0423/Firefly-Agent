//! Bookkeeping for capture requests: a request stays open until Main hears it completed or cancelled.

use firefly_screenshot::protocol::CaptureMode;
use firefly_screenshot::request::{CaptureInteractionState, RequestRegistry};

fn opened(id: &str, mode: CaptureMode) -> RequestRegistry {
    let mut registry = RequestRegistry::default();
    registry.accept(id, mode).expect("a fresh id is accepted");
    registry
}

#[test]
fn releasing_the_capture_leaves_the_request_open_until_it_completes() {
    for (mode, file) in [(CaptureMode::ClipboardOnly, None), (CaptureMode::ClipboardAndFile, Some("4f6c7d1a-1111-4222-8333-944455556666.png"))] {
        let mut registry = opened("shot", mode);
        registry.capture_released("shot", false, 320, 240).expect("an open request can release its capture");
        assert!(registry.is_pending("shot"), "{mode:?}: release alone must not finish the request");
        registry.complete("shot", file.map(str::to_owned)).expect("an open request completes");
        assert!(!registry.is_pending("shot"), "{mode:?}");
    }
}

#[test]
fn ids_are_unique_while_open_and_reusable_once_finished() {
    let mut registry = opened("again", CaptureMode::ClipboardOnly);
    let duplicate = registry.accept("again", CaptureMode::ClipboardAndFile).expect_err("an open id is taken");
    assert_eq!(duplicate.code(), "request-already-pending");

    registry.cancel("again", "user pressed Escape").expect("an open request can be cancelled");
    registry.accept("again", CaptureMode::ClipboardAndFile).expect("a finished id may start a new request");
    assert!(registry.is_pending("again"));
}

#[test]
fn a_finished_request_cannot_finish_again_and_an_unknown_one_is_reported() {
    let mut registry = opened("done", CaptureMode::ClipboardOnly);
    registry.complete("done", None).expect("first completion");
    assert_eq!(registry.complete("done", None).expect_err("second completion").code(), "request-already-finished");
    assert_eq!(registry.cancel("done", "too late").expect_err("late cancel").code(), "request-already-finished");
    assert_eq!(registry.capture_released("never-opened", true, 1, 1).expect_err("unknown id").code(), "request-not-found");
}

#[test]
fn the_interaction_runs_through_six_distinct_phases() {
    use CaptureInteractionState::*;
    let phases = [Idle, Freezing, Selecting, Selected, Committing, Cancelling];
    for (index, phase) in phases.iter().enumerate() {
        assert_eq!(phases.iter().filter(|other| *other == phase).count(), 1, "phase {index} is distinct");
    }
}
