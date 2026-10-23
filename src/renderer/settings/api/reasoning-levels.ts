// API 档案里的"推理强度档位"表单：默认跟随型号名规则表（自动），
// 关掉自动后由用户勾选这个 API 实际支持的档位，保存进档案并优先于规则表。
import { normalizeReasoningLevels, type ReasoningEffort, type ReasoningLevelsConfig } from "../../../shared/reasoning";

const AUTO = "#reasoning-levels-auto";
const OPTIONS = "#reasoning-levels-options";
const EFFORT_BOXES = "input[data-effort]";
const OFF = "#reasoning-levels-off";
/** 刚关掉自动、还没勾任何档位时给的起点：最常见的三档。 */
const STARTING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

function parts(root: ParentNode) {
  return {
    auto: root.querySelector<HTMLInputElement>(AUTO),
    options: root.querySelector<HTMLElement>(OPTIONS),
    efforts: [...root.querySelectorAll<HTMLInputElement>(EFFORT_BOXES)],
    off: root.querySelector<HTMLInputElement>(OFF),
  };
}

/** 自动时返回 undefined（= 档案没声明，按型号规则表）。 */
export function readReasoningLevels(root: ParentNode = document): ReasoningLevelsConfig | undefined {
  const { auto, efforts, off } = parts(root);
  if (!auto || auto.checked) return undefined;
  return normalizeReasoningLevels({
    efforts: efforts.filter((box) => box.checked).map((box) => box.dataset.effort),
    allowOff: off?.checked === true,
  });
}

function syncDisabled(root: ParentNode): void {
  const { auto, options, efforts, off } = parts(root);
  const locked = auto?.checked !== false;
  for (const box of [...efforts, off]) if (box) box.disabled = locked;
  options?.classList.toggle("is-locked", locked);
  options?.setAttribute("aria-disabled", String(locked));
}

export function writeReasoningLevels(levels: ReasoningLevelsConfig | undefined, root: ParentNode = document): void {
  const { auto, efforts, off } = parts(root);
  if (!auto) return;
  const normalized = normalizeReasoningLevels(levels);
  auto.checked = normalized === undefined;
  for (const box of efforts) box.checked = normalized?.efforts.includes(box.dataset.effort as ReasoningEffort) === true;
  if (off) off.checked = normalized?.allowOff === true;
  syncDisabled(root);
}

/** 绑定"自动"开关：从自动切到手动时，如果一个档位都没勾，先给一个常见起点。 */
export function bindReasoningLevels(root: ParentNode = document): void {
  const { auto } = parts(root);
  if (!auto) return;
  auto.addEventListener("change", () => {
    if (!auto.checked) {
      const { efforts, off } = parts(root);
      const untouched = efforts.every((box) => !box.checked) && !off?.checked;
      if (untouched) for (const box of efforts) box.checked = STARTING_EFFORTS.includes(box.dataset.effort as ReasoningEffort);
    }
    syncDisabled(root);
  });
  syncDisabled(root);
}
