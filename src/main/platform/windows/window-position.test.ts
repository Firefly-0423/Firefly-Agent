import { afterEach, it, expect, vi } from "vitest";
import { WINDOW_COORDINATE_LIMIT as limit, normalizeWindowPosition as position, normalizeWindowCoordinate as coordinate } from "./window-position";
import { PetWindowMoveController, type PetWindowLike } from "./pet-window-movement";

afterEach(() => vi.useRealTimers());

it("rounds coordinates, bounds them, and rejects malformed pairs", () => {
  expect([82.4, -82.6, limit + 1, -limit - 1].map(coordinate)).toEqual([82, -83, limit, -limit]);
  expect(position(42.4, -37.6)).toEqual({ x: 42, y: -38 });
  expect(position(2_000_000, -2_000_000)).toEqual({ x: limit, y: -limit });
  for (const invalid of [undefined, "12", NaN, Infinity, -Infinity]) {
    expect(coordinate(invalid)).toBeNull();
    expect(position(invalid, 8)).toBeNull();
    expect(position(8, invalid)).toBeNull();
  }
});
function desktop() {
  let current = [50, 90];
  return { isDestroyed: () => false, getPosition: vi.fn(() => current),
    setPosition: vi.fn((x: number, y: number) => { current = [x, y]; }) };
}
it("applies each distinct renderer position immediately and persists only on drag completion", () => {
  const window = desktop(), save = vi.fn();
  const movement = new PetWindowMoveController(() => window, save);
  movement.queueAbsolute(61, 101);
  movement.queueAbsolute(72, 112);
  movement.queueAbsolute(83, 123);
  expect(window.setPosition.mock.calls).toEqual([[61, 101, false], [72, 112, false], [83, 123, false]]);
  expect(save).not.toHaveBeenCalled();
});
it("rounds the last movement and saves its final coordinates once", () => {
  const window = desktop(), save = vi.fn();
  const movement = new PetWindowMoveController(() => window, save);
  movement.queueAbsolute(61.4, 102.6);
  movement.finishDragging();
  expect(window.setPosition).toHaveBeenCalledExactlyOnceWith(61, 103, false);
  expect(save).toHaveBeenCalledExactlyOnceWith({ x: 61, y: 103 });
});
it("ignores invalid moves, repeated coordinates and destroyed windows", () => {
  vi.useFakeTimers();
  const window = desktop(), save = vi.fn();
  const movement = new PetWindowMoveController(() => window, save);
  movement.queueAbsolute(NaN, 90);
  movement.moveRelative(Infinity, 4);
  movement.queueAbsolute(50, 90);
  vi.runAllTimers();
  expect(window.setPosition).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  const closed: PetWindowLike = { isDestroyed: () => true, getPosition: vi.fn(), setPosition: vi.fn() };
  const unavailable = new PetWindowMoveController(() => closed, save);
  unavailable.queueAbsolute(800, 600);
  unavailable.finishDragging();
  vi.runAllTimers();
  expect(closed.getPosition).not.toHaveBeenCalled();
  expect(closed.setPosition).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
