// 1.2.0 示例插件冒烟测试（在临时外部项目中运行，导入已安装的 @firefly_wu/plugin-sdk/testing）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTestHost } from "@firefly_wu/plugin-sdk/testing";

const [sourcesRoot, packagesRoot] = process.argv.slice(2);

async function checkWeather() {
  const dir = path.join(sourcesRoot, "dev.firefly.weather");
  const pkgBytes = await readFile(path.join(packagesRoot, "dev.firefly.weather.ffplugin"));
  assert.equal(pkgBytes.subarray(0, 2).toString("utf8"), "PK");

  const manifest = JSON.parse(await readFile(path.join(dir, "firefly.plugin.json"), "utf8"));
  const mod = await import(pathToFileURL(path.join(dir, manifest.main)).href);

  let fetchCalls = 0;
  const plugin = mod.createWeatherPlugin({
    fetchImpl: async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "Shanghai", main: { temp: 21, humidity: 55 }, weather: [{ description: "多云" }] }),
      };
    },
  });

  const host = createTestHost({ manifest, mode: "work", level: "full", secrets: { api_key: "smoke-key" } });
  await host.activate(plugin);

  const invalid = await host.callTool("get_weather", { city: "   " });
  assert.equal(invalid.status, "not_executed");
  assert.equal(fetchCalls, 0);

  const ok = await host.callTool("get_weather", { city: "Shanghai" });
  assert.equal(ok.status, "succeeded");
  assert.equal(fetchCalls, 1);

  await host.deactivate("disabled");
  console.log("[smoke] dev.firefly.weather 通过");
}

async function checkReminder() {
  const dir = path.join(sourcesRoot, "dev.firefly.reminder");
  const pkgBytes = await readFile(path.join(packagesRoot, "dev.firefly.reminder.ffplugin"));
  assert.equal(pkgBytes.subarray(0, 2).toString("utf8"), "PK");

  const manifest = JSON.parse(await readFile(path.join(dir, "firefly.plugin.json"), "utf8"));
  const mod = await import(pathToFileURL(path.join(dir, manifest.main)).href);

  let modelCalls = 0;
  const host = createTestHost({
    manifest,
    mode: "work",
    level: "full",
    model: {
      generate: async () => {
        modelCalls++;
        return { text: "记得喝水休息一下。" };
      },
    },
  });
  await host.activate(mod.default);

  const proposed = await host.callTool("create_daily_reminder", {
    title: "喝水",
    topic: "喝水提醒",
    timeOfDay: "09:00",
  });
  assert.equal(proposed.status, "succeeded");
  assert.equal(proposed.output.status, "pending_approval");
  assert.equal(modelCalls, 0);

  host.approveSchedule(proposed.output.taskId);
  await host.triggerSchedule(proposed.output.taskId, { topic: "喝水提醒" });
  assert.equal(modelCalls, 1);

  await host.deactivate("disabled");
  console.log("[smoke] dev.firefly.reminder 通过");
}

await checkWeather();
await checkReminder();
