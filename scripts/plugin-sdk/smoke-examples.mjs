// 示例插件冒烟测试。运行位置是临时项目（SDK 已从 tarball 装进它的 node_modules）。
// 对每个示例检查：能完成 register、工具 id 符合约定、停止流程不抛错。
// 用法：node smoke.mjs <install 目录>，目录下每个子目录是一个已组装好的插件。
import { createRequire } from "node:module";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { createMockPluginContext, assertPluginTool, assertValidManifest } = require("@firefly/plugin-sdk/testing");

const installRoot = process.argv[2];

/** 各项宿主服务的最小假实现，只够示例在注册阶段使用。 */
const FAKE_SERVICES = {
  secrets: () => ({
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => false,
  }),
  scheduler: () => {
    const sampleTask = {
      id: "task-1",
      title: "t",
      prompt: "p",
      mode: "chat",
      schedule: { kind: "daily", timeOfDay: "09:00" },
      allowedToolIds: [],
      enabled: false,
      nextFireAt: null,
      createdAt: "",
      updatedAt: "",
    };
    return {
      createTask: async () => ({ ...sampleTask }),
      listTasks: async () => [{ ...sampleTask }],
      updateTask: async () => ({ ...sampleTask }),
      deleteTask: async () => true,
      getHistory: async () => [],
    };
  },
  llm: () => ({ generateText: async () => "摘要" }),
  conversations: () => ({
    list: async () => ({ items: [] }),
    getMessages: async () => ({ items: [], range: {} }),
  }),
};

/** 按 manifest 声明的 deps 生成假服务；不认识的依赖名直接忽略。 */
function fakeDepsFor(manifest) {
  const deps = {};
  for (const name of manifest.deps ?? []) {
    if (Object.hasOwn(FAKE_SERVICES, name)) deps[name] = FAKE_SERVICES[name]();
  }
  return deps;
}

/** 完整检查一个插件目录；任何一步失败都会抛出。 */
async function smokeTest(pluginDir, dirName) {
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "manifest.json"), "utf8"));
  assertValidManifest(manifest);

  // manifest.entry 指向的产物必须存在、能加载，并且导出 register
  const plugin = require(path.join(pluginDir, manifest.entry));
  if (typeof plugin?.register !== "function") {
    throw new Error("入口导出缺少 register 函数");
  }

  const ctx = createMockPluginContext({ pluginId: manifest.id, deps: fakeDepsFor(manifest) });
  if (plugin.open) await plugin.open();
  await plugin.register(ctx);
  ctx.tools.forEach((tool) => assertPluginTool(tool, manifest.id));

  // 停止流程：框架清理与 unregister 都不应抛错
  await ctx.dispose();
  if (plugin.unregister) await plugin.unregister();

  console.log(`[smoke] ${dirName}: register ${ctx.tools.length} 个工具, 契约通过`);
}

let anyFailed = false;
for (const dirName of await readdir(installRoot)) {
  try {
    await smokeTest(path.join(installRoot, dirName), dirName);
  } catch (error) {
    anyFailed = true;
    console.error(`[smoke] ${dirName} 失败:`, error);
  }
}
if (anyFailed) process.exit(1);
