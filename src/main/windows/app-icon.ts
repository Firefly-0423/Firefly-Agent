import * as path from "path";
import type { UiIcon } from "../../shared/ui-icon";

export function getAppIconPath(icon: UiIcon): string {
  void icon;
  return path.join(__dirname, "..", "..", "..", "renderer", "avatars", "firefly-avatar.png");
}
