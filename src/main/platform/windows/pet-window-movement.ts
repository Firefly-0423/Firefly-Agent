import { type WindowPosition, normalizeWindowPosition, normalizeWindowCoordinate } from "./window-position";

export type PetWindowLike = {
  setPosition(x: number, y: number, animate?: boolean): void;
  getPosition(): number[];
  isDestroyed(): boolean;
};
type MovementWarning = (message: string, error: unknown) => void;

export class PetWindowMoveController {
  constructor(
    private readonly readWindow: () => PetWindowLike | null,
    private readonly savePosition: (position: WindowPosition) => void,
    private readonly reportWarning: MovementWarning = (message, error) => console.warn(message, error),
  ) {}

  private readActiveWindow(): PetWindowLike | null {
    const candidate = this.readWindow();
    if (candidate && !candidate.isDestroyed()) return candidate;
    return null;
  }

  private attempt(action: () => void, diagnostic: string): void {
    try { action(); } catch (failure) { this.reportWarning(diagnostic, failure); }
  }

  private updateWindow(target: PetWindowLike, destination: WindowPosition): void {
    const coordinates = target.getPosition();
    const existing = normalizeWindowPosition(coordinates[0], coordinates[1]);
    if (existing?.x === destination.x && existing.y === destination.y) return;
    target.setPosition(destination.x, destination.y, false);
  }

  moveRelative(dx: unknown, dy: unknown): void {
    const horizontal = normalizeWindowCoordinate(dx);
    const vertical = normalizeWindowCoordinate(dy);
    if (horizontal === null || vertical === null) return;
    const target = this.readActiveWindow();
    if (!target) return;
    this.attempt(() => {
      const [left, top] = target.getPosition();
      const destination = normalizeWindowPosition(left + horizontal, top + vertical);
      if (destination) this.updateWindow(target, destination);
    }, "[Firefly] Failed to move pet window relatively:");
  }

  queueAbsolute(x: unknown, y: unknown): void {
    const destination = normalizeWindowPosition(x, y);
    if (!destination) return;
    const target = this.readActiveWindow();
    if (!target) return;
    this.attempt(() => this.updateWindow(target, destination), "[Firefly] Failed to move pet window:");
  }

  finishDragging(): void {
    const target = this.readActiveWindow();
    if (!target) return;
    this.attempt(() => {
      const [left, top] = target.getPosition();
      const destination = normalizeWindowPosition(left, top);
      if (destination) this.savePosition(destination);
    }, "[Firefly] Failed to persist the pet window position:");
  }
}
