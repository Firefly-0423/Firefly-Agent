# 生产依赖安全审计基线与风险登记表建设

状态：风险基线已建立并合入（PR `#63`）；四个受影响包之安装包落点与漏洞可达性均标为“待核实”，等待 `hotaru` 审阅结论  
日期：2026-11-14（审计基线采集日及 PR `#63` 合入日）

## 为什么做

虽然 `.github/workflows/test.yml` 此前已配有非阻断的 `npm audit --omit=dev --json` 与 `npm-audit-prod` 产物上传，但仓库一直缺少把审计报告转化为可追踪风险台账的规范文档（对应 `docs/superpowers/plans/2026-11-12-docs-and-engineering.md` 施工包 C：C1–C3）。

在不主动擅自升级生产依赖、不改变锁文件与不把审计改成 CI 硬阻断的前提下，工程侧需要建立一套面向发布审查的基线台账，准确记录每个漏洞包实例的完整依赖链、安装位置假设、触发前提与关闭证据标准，防止“跑了静态单测”或“改了 override 但未查 ASAR”被误认为风险关闭。

## 改了什么（前后结构对照）

| 维度 | 建立基线前 | 建立基线后（PR `#63`） |
| --- | --- | --- |
| 风险台账文档 | 只有 CI 临时生成的 `npm-audit-prod` artifact，无仓库内长期风险记录与责任跟踪 | 新建 [dependency-risk-register.md](../security/dependency-risk-register.md)，明确采集基线（提交 `74d4d4e39daad7a469dbe40043af00853b27026d`、`package-lock.json` SHA-256 `b8105b1227bee8b2fd089989e1502e8b2e66fbaf34000fdc64092988de4f5499`）、4 个受影响实例（`DEP-001`–`DEP-012`，共 11 项公告 + 1 条传递影响） |
| 依赖链与入包假设核对 | 缺少对 `node-forge`、`hono` 等传递依赖精确来源与 `asarUnpack` 配置的集中说明 | 通过 `npm explain <包名> --json` 逐条列出完整链：`@anthropic-ai/sandbox-runtime@0.0.71` → `node-forge@1.4.2`、`@modelcontextprotocol/sdk@1.32.2` → `@hono/node-server@2.1.5` 与 `hono@4.13.14`，并核查 `electron-builder.yml` 与 `src/main/agent/sandbox/sandbox-exec.ts` 配置预期入包路径 |
| 状态流转与关闭门禁定义 | 无统一的评估、例外审批和关闭标准 | 定义“待核实 → 已确认 → 待修复 / 临时例外 → 待验证 → 已关闭”五段流转，硬性要求关闭须附升级提交、真实安装包/ASAR 落点、入口回归与复核人；临时例外须经 `hotaru` 审核并设到期日 |
| 维护操作入口 | 缺少日常重新采集和例外续期指引 | 在 `scripts/README.md` 补充生产依赖审计重新采集、入包判断与例外续期操作指南及风险登记表链接 |

## 怎么验证的

1. **原始审计采集与依赖链解析**（`2026-11-12-docs-and-engineering-progress.md` §C 施工记录）：
   - 运行 `npm audit --omit=dev --json` 成功获得合法 `auditReportVersion 2` 报告（退出码 1；汇总 low 1、moderate 3、high 0、critical 0，4 个受影响包、11 个公告及 1 条传递影响）；
   - 对 4 个目标包逐一运行 `npm explain <包名> --json`，全部退出 0，并将同版本多引用链完整写入登记表。
2. **构建输入核查**（`docs/security/dependency-risk-register.md` §构建与分发核查记录）：
   - 2026-11-14 执行 `npm run build`（退出 0），验证 `dist/main/main/agent/sandbox/sandbox-exec.js` 仍保持对 `sandbox-runtime` 的动态导入、主进程 MCP 模块保持对 SDK 的引用。
3. **链接与锁文件校验**：`docs/security/dependency-risk-register.md` 与 `scripts/README.md` 的双向链接已通过本地文件校验，`package-lock.json` SHA-256 保持未改动。

## 涉及的 PR

- **PR `#63`**（`d2d1184`，2026-11-14）：`feat/docs-eng`（施工包 C：新增 `docs/security/dependency-risk-register.md`，扩展 `scripts/README.md` 生产依赖维护段，与测试工作流审计步骤配套）。

## 遗留事项

1. **真实安装包 ASAR 落点与漏洞可达性待核实**：`DEP-001`–`DEP-012`（`@hono/node-server@2.1.5`、`hono@4.13.14`、`node-forge@1.4.2`、`@anthropic-ai/sandbox-runtime@0.0.71`）均处于“待核实”状态，因缺少截图 helper、MinGit 与模型目录等打包输入，尚未检查真实 `resources/app.asar` 内的文件与上游路由/TLS 入口在实际运行时是否可达。
2. **排期与升级决策待 `hotaru` 审阅**：登记表中目标日期与复核日期暂定为 `2026-11-21`（若早于该日发版则须发版前完成），尚无已批准临时例外，亦未立项具体升级 PR（candidates：`@hono/node-server@2.1.6`、`hono@4.13.16`、`node-forge@1.4.3`）。
