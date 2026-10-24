import {
  timeoutUserChoiceInput, timeoutUserChoiceReset, timeoutTestInput, timeoutTestReset,
  maxParallelToolCallsInput, maxToolRoundsInput, runTimeoutMinutesInput,
} from "./dom";
import { modelRequestTimeoutSecInput, modelRequestTimeoutSecReset } from "../api/dom";
import { setSaveStatus, setRuntimeSaveStatus } from "../shared/save-status";
import { parsePositiveIntOrThrow } from "../shared/parse";
import type { TimeoutSettings } from "../../../shared/timeout-types";

function parseNonNegativeOrDefault(value: string, fallback: number): number {
  const numeric = Number(value);
  if (value.trim() === "" || !Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.trunc(numeric);
}

export async function loadTimeoutSettings(): Promise<void> {
  try {
    const timeouts = await window.settings!.getTimeoutSettings();
    timeoutUserChoiceInput.value = String(timeouts.userChoiceTimeout / 1000);
    timeoutTestInput.value = String(timeouts.testTimeout);
    modelRequestTimeoutSecInput.value = timeouts.modelRequestTimeoutSec != null ? String(timeouts.modelRequestTimeoutSec) : "";
    const runtime = await window.settings!.getGeneral();
    maxParallelToolCallsInput.value = String(runtime.maxParallelToolCalls ?? 4);
    maxToolRoundsInput.value = String(runtime.maxToolRounds ?? 200);
    runTimeoutMinutesInput.value = String(runtime.runTimeoutMinutes ?? 120);
    setRuntimeSaveStatus("时间设置保存后，对后续请求生效。");
  } catch {
    setRuntimeSaveStatus("读取偏好失败", "is-error");
  }
}

function readTimeoutPatch(testOnly: boolean): Partial<TimeoutSettings> {
  if (testOnly) return { testTimeout: parsePositiveIntOrThrow(timeoutTestInput.value, "测试超时") };
  return {
    userChoiceTimeout: 1000 * parsePositiveIntOrThrow(timeoutUserChoiceInput.value, "询问等待时间"),
    modelRequestTimeoutSec: modelRequestTimeoutSecInput.value === "" ? undefined : parsePositiveIntOrThrow(modelRequestTimeoutSecInput.value, "模型请求超时"),
  };
}

export async function saveTimeoutSettings(saveTestTimeout: boolean): Promise<boolean> {
  // 测试表单与运行偏好各自显示保存状态。
  const report = saveTestTimeout ? setSaveStatus : setRuntimeSaveStatus;
  let patch: Partial<TimeoutSettings>;
  try {
    patch = readTimeoutPatch(saveTestTimeout);
  } catch (failure) {
    report("无效输入：" + failure, "is-error");
    return false;
  }
  try {
    await window.settings!.saveTimeoutSettings(patch);
    if (!saveTestTimeout) {
      const parallelism = Number(maxParallelToolCallsInput.value);
      await window.settings!.saveGeneral({
        maxParallelToolCalls: Number.isFinite(parallelism) ? parallelism : 4,
        maxToolRounds: parseNonNegativeOrDefault(maxToolRoundsInput.value, 200),
        runTimeoutMinutes: parseNonNegativeOrDefault(runTimeoutMinutesInput.value, 120),
      });
    }
    report("已保存", "is-ok");
    return true;
  } catch {
    report("保存失败", "is-error");
    return false;
  }
}

function bindReset(button: HTMLButtonElement, input: HTMLInputElement, value: string): void {
  button.addEventListener("click", () => { input.value = value; });
}
bindReset(timeoutTestReset, timeoutTestInput, "15000");
bindReset(timeoutUserChoiceReset, timeoutUserChoiceInput, "60");
bindReset(modelRequestTimeoutSecReset, modelRequestTimeoutSecInput, "");
void loadTimeoutSettings();
