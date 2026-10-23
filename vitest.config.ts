import ArchiveReporter from "./scripts/testing/archive-reporter.mjs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    reporters: ["default", new ArchiveReporter()],
    include: [
      "src/plugins/**/*.test.ts",
      "src/main/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/cli/**/*.test.ts",
      "skills/**/tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    // 单 fork 单 worker，避免 Windows 下 libuv fs-event 断言崩溃
    pool: "forks",
    singleFork: true,
    maxWorkers: 1,
    minWorkers: 1,
    // 托管的 Windows 运行器上，启动 PowerShell / Python、真实 SQLite 的测试偶发数秒级停顿（探测显示磁盘与 CPU 本身正常，
    // 同一提交的另一次运行常常通过）。CI 里把单测与钩子的超时放宽到 30 秒，只影响“卡住时多等多久”，不放宽任何断言；
    // 本地仍用 Vitest 默认值，卡住的测试在本地依旧快速失败。
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    // 明确禁用 watch/cache，减少 fs 事件
    watch: false,
    cache: false,
    fileParallelism: false,
  },
});
