# 测试文件未被纳入任何 TypeScript 类型检查配置，Vitest 亦不做类型检查

状态：待负责人决定
日期：2026-11-16

## 现象

1. 全仓 `tsconfig.main.json`、`tsconfig.preload.json` 与 `tsconfig.renderer.json` 均排除了对应端下的测试与测试辅助文件；根 `tsconfig.json` 仅做项目引用，也不包含测试文件。
2. `vitest.config.ts` 运行单元测试时不执行 TypeScript 类型检查（只要语法可被转换即正常运行）。
3. 这导致测试文件内缺少类型导入、错误对象或全局声明缺失等问题在 `npm test` 与常规 `tsc --noEmit` 门禁下都会被放过。例如施工包 B 单独用 TypeScript API 扫描测试文件时，发现某测试用了 `ChatMessageItem` 却未导入，而既有的 `ChatPage.plan-lifecycle.test.ts` 存在 11 条诊断（`window.agui` / `window.chatStore` 缺全局类型）一直未暴露。
4. 此外，独立窗口目录（如提醒窗口 `src/renderer/toast/**`）同样未纳入 `tsconfig.renderer.json` 的 `include` 列表（未合并分支 `feat/chatpage-g` 的 `e26ae78` 进度记录亦标注了该缺口）。

## 触发条件或复现步骤

1. 查看 `tsconfig.json`（仅有 4 条 `references`：`tsconfig.main.json`、`tsconfig.preload.json`、`tsconfig.renderer.json`、`tsconfig.sim.json`）。
2. 查看 `tsconfig.main.json`（`exclude` 含 `src/**/*.test.ts`、`src/**/*.acceptance.ts`、`src/**/*.test-support.ts`）、`tsconfig.preload.json`（`exclude` 含 `src/**/*.test.ts`、`src/**/*.test-support.ts`）与 `tsconfig.renderer.json`（`exclude` 含 `src/renderer/react/**/*.test.ts`、`src/renderer/react/**/*.test.tsx`、`src/shared/logger.test.ts`，且 `include` 仅涵盖 `react`、`react-perf`、`web-demo`、`site` 等，未覆盖 `src/renderer/toast` 与部分纯 TS 测试/页面目录）。
3. 在任一测试文件中引用未导入类型或缺失接口属性，分别运行 `npm test` 与 `tsc -p tsconfig.<target>.json --noEmit`，均会通过。

## 影响范围

- **受影响范围**：`src/main`、`src/preload`、`src/renderer`、`src/shared` 等所有未被构建 `tsconfig` 包含的 `*.test.ts` / `*.test.tsx` / `*.test-support.ts` / `*.acceptance.ts` 及未入配置的页面目录。
- **质量风险**：类型回归和错用测试桩签名只能靠人工或借 TypeScript Compiler API 临时拼装检查发现，无法在 CI 自动拦截。

## 根因

- 生产构建的 `tsconfig.*.json` 需要避免将 `*.test.*` 和 `*.test-support.ts`（以及开发依赖如 `typescript`）编入 `dist/` 安装包（参见 `coupling-audit-followup-progress.md` §2 R2.3/R2.4）。
- 但工程门禁里没有单独设立面向测试文件（含 `test-support` 与各窗口前端代码）的 `tsconfig.test.json`（`noEmit: true`）检查步骤。

## 当前状态

- **待负责人决定**：`docs/superpowers/plans/chatpage-regression-progress.md` §5 明确记录：是否把测试文件（以及如 `toast` 等未入配置页面）的类型检查纳入 CI，留待负责人另行决定；施工包 A、B（及未合并的 G）当前采用临时以 TypeScript API 单独检查相关测试文件作为过渡验证（详见进度文档 §4、§5）。

## 相关文件

- `docs/superpowers/plans/chatpage-regression-progress.md`（§4 验证记录、§5 偏离计划）
- `docs/superpowers/plans/test-assertion-hardening-progress.md`（§5 T2 记录）
- `docs/superpowers/plans/coupling-audit-followup-progress.md`（§2 R2.3/R2.4）
- `tsconfig.json`、`tsconfig.main.json`、`tsconfig.preload.json`、`tsconfig.renderer.json`
- `vitest.config.ts`
