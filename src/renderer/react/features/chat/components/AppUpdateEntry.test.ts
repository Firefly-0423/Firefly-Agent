import { expect, test } from "vitest";
import { resolveAppUpdateEntryView } from "./AppUpdateEntry";

test.each(["error", "not_available", "checking", "idle"] as const)("hides the updater during %s", (phase) => {
  expect(resolveAppUpdateEntryView({ phase, currentVersion: "3.4.2", error: "network down" })).toBeNull();
});

test("maps a release and an installed download to their next actions", () => {
  const available = resolveAppUpdateEntryView({ phase: "available", currentVersion: "3.4.2", availableVersion: "3.5.0" });
  expect(available).toStrictEqual({ disabled: false, action: "download", label: "发现新版本 v3.5.0" });
  const downloaded = resolveAppUpdateEntryView({ phase: "downloaded", currentVersion: "3.4.2", percent: 100 });
  expect(downloaded).toStrictEqual({ disabled: false, action: "install", label: "重启并更新" });
});

test.each([[42.4, 42], [42.5, 43], [-1, 0], [120, 100], [undefined, 0]])(
  "rounds and clamps download progress %s", (percent, displayed) => {
    expect(resolveAppUpdateEntryView({ phase: "downloading", currentVersion: "3.4.2", percent }))
      .toStrictEqual({ disabled: true, action: null, label: `正在下载 ${displayed}%` });
  });
