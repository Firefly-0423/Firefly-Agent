# 生产依赖风险登记

状态为风险登记，采集日期 2026-11-14，维护者 hotaru。

## 基线与采集

本次登记中每条记录均采用以下审计基线。

| 字段 | 值 |
|---|---|
| 审计命令 | `npm audit --omit=dev --json` |
| 基线提交 | `74d4d4e39daad7a469dbe40043af00853b27026d` |
| package-lock.json SHA-256 | `b8105b1227bee8b2fd089989e1502e8b2e66fbaf34000fdc64092988de4f5499` |
| 命令退出码 | 1，返回有效 auditReportVersion 2，采集成功 |
| npm 汇总 | 4 个受影响包条目，low 1、moderate 3、high 0、critical 0 |
| 公告数量 | 11 个公告，另有 sandbox-runtime 的传递影响条目 |
| 审计原始记录 | 本地忽略目录 `output/docs-eng/npm-audit-prod.json`，CI 对应 npm-audit-prod artifact |
| 依赖链证据 | 对下表四个包分别运行 `npm explain <包名> --json`，全部退出 0；锁文件逐实例核对 |

审计条目数包含传递影响，与公告数不同。采集失败时记录命令、错误和失败日期，保留上次成功基线，当前状态写“采集失败”。包管理器覆盖版本配置只是安装现状证据，仍需核对新公告和最终产物。

## 受影响实例及完整依赖链

锁文件与已安装依赖中，下列各有一个版本实例。Hono 同一实例由两条链引用，均列出。路径均相对应用或源码根。

| 实例 | 直接或传递与完整链 | 配置入包位置及当前证据 |
|---|---|---|
| @anthropic-ai/sandbox-runtime@0.0.71 | 直接，firefly-agent@1.1.4 → @anthropic-ai/sandbox-runtime@0.0.71 | 生产依赖，预计 `resources/app.asar/node_modules/@anthropic-ai/sandbox-runtime`，实际安装包待核实 |
| node-forge@1.4.2 | 传递，firefly-agent@1.1.4 → @anthropic-ai/sandbox-runtime@0.0.71 → node-forge@1.4.2 | 生产依赖，预计 `resources/app.asar/node_modules/node-forge`，实际安装包待核实 |
| @hono/node-server@2.1.5 | 传递，firefly-agent@1.1.4 → @modelcontextprotocol/sdk@1.32.2 → @hono/node-server@2.1.5 | 生产依赖，预计 `resources/app.asar/node_modules/@hono/node-server`，实际安装包待核实 |
| hono@4.13.14 | 传递，firefly-agent@1.1.4 → @modelcontextprotocol/sdk@1.32.2 → hono@4.13.14；另有 firefly-agent@1.1.4 → @modelcontextprotocol/sdk@1.32.2 → @hono/node-server@2.1.5 → hono@4.13.14（peer） | 生产依赖，预计 `resources/app.asar/node_modules/hono`，实际安装包待核实 |

`electron-builder.yml` 的 files 纳入 dist、package.json 与生产依赖，未排除这四个实例。asarUnpack 只特别展开指定依赖，extraResources 未另外携带这些包。源码 `src/main/agent/sandbox/sandbox-exec.ts` 的 `initSandbox` 动态导入 sandbox-runtime，MCP 入口使用 SDK。当前代码包版本仍为 1.1.4，该数字来自实际 manifest。构建产物及分发目录检查结果随验证追加，包内真实文件与漏洞可达性仍需逐项核对。

## 公告登记

下表每行均关联上表精确实例、全部依赖链与基线。当前状态均为“待核实”，表示版本命中已确认、最终入包和触发可达性待核实。每项责任人均为 hotaru，目标日期与复核日期暂定 2026-11-21，发布早于该日期时应在发布前完成。日期为本次施工建议，待负责人审核。未批准临时例外，无例外到期日或关闭证据。

| 登记编号 | 包名与精确版本 | 公告 | 严重程度 | 输入、入口及触发前提 | 上游修复路径与兼容性影响 |
|---|---|---|---|---|---|
| DEP-001 | @hono/node-server@2.1.5 | [GHSA-qv5m-9pm6-hqp3](https://github.com/advisories/GHSA-qv5m-9pm6-hqp3) | moderate | 网络 socket ECONNRESET；异步 WebSocket upgrade 期间未处理异常，需实际启动该服务入口，Firefly 调用可达性待核实 | 候选 2.1.6，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-002 | @hono/node-server@2.1.5 | [GHSA-jpvv-r467-5p4w](https://github.com/advisories/GHSA-jpvv-r467-5p4w) | moderate | 请求路径反斜杠；反向代理与应用路径解释不一致且依赖路径访问控制，Firefly 调用可达性待核实 | 候选 2.1.6，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-003 | hono@4.13.14 | [GHSA-4m76-xfj5-7975](https://github.com/advisories/GHSA-4m76-xfj5-7975) | moderate | 请求路径；mount/app.mount 前缀内中间件边界，Firefly 调用可达性待核实 | 候选 4.13.16，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-004 | hono@4.13.14 | [GHSA-h7mg-cq63-vhpq](https://github.com/advisories/GHSA-h7mg-cq63-vhpq) | moderate | 路由集合与编码行终止符；RegExpRouter 通配符中间件，Firefly 调用可达性待核实 | 候选 4.13.16，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-005 | hono@4.13.14 | [GHSA-3gg2-335m-rxc6](https://github.com/advisories/GHSA-3gg2-335m-rxc6) | low | 模板插值；css helper 的闭合标签跨模板与变量拆分，Firefly 调用可达性待核实 | 候选 4.13.16，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-006 | hono@4.13.14 | [GHSA-46wx-v44x-9hh2](https://github.com/advisories/GHSA-46wx-v44x-9hh2) | moderate | 浏览器 text/ping 请求；使用 csrf 中间件的路由，Firefly 调用可达性待核实 | 候选 4.13.16，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-007 | hono@4.13.14 | [GHSA-4h7h-rv7c-7m2v](https://github.com/advisories/GHSA-4h7h-rv7c-7m2v) | moderate | multipart/form-data 参数；使用 validator(form) 的路由，Firefly 调用可达性待核实 | 候选 4.13.16，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-008 | node-forge@1.4.2 | [GHSA-6889-vf6x-f3g5](https://github.com/advisories/GHSA-6889-vf6x-f3g5) | low | 小阶公钥和签名；调用 Ed25519 验证入口，Firefly 调用可达性待核实 | 候选 1.4.3，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-009 | node-forge@1.4.2 | [GHSA-w4xr-hqv8-ch44](https://github.com/advisories/GHSA-w4xr-hqv8-ch44) | moderate | 远端 ServerHello 压缩方法；forge.tls 客户端未捕获 process 异常，Firefly 调用可达性待核实 | 候选 1.4.3，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-010 | node-forge@1.4.2 | [GHSA-6cv4-p8m7-4r25](https://github.com/advisories/GHSA-6cv4-p8m7-4r25) | moderate | 响应头或 cookie 字符串；forge.http 正则修剪入口，Firefly 调用可达性待核实 | 候选 1.4.3，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-011 | node-forge@1.4.2 | [GHSA-j8rw-jp99-435v](https://github.com/advisories/GHSA-j8rw-jp99-435v) | moderate | 无会话握手记录；forge.tls 客户端处理入口，Firefly 调用可达性待核实 | 候选 1.4.3，独立变更覆盖版本并跑调用/兼容回归，当前未升级 |
| DEP-012 | @anthropic-ai/sandbox-runtime@0.0.71 | 传递影响来自 DEP-008–011 的 node-forge 公告 | low（npm 传播评级） | `initSandbox` 加载的沙箱依赖；需检查上游实际调用的 forge 功能 | 跟进上游 node-forge 升级或单独审查 override，确认沙箱兼容性 |

2026-11-14 已从上游公告核对 Hono 4.13.16、node-server 2.1.6，以及 forge TLS 压缩问题的 1.4.3 修复版本。其他 forge 公告候选同样为 1.4.3，须在升级任务逐公告复核。公告入口链接保留在各登记行。

## 缓解、责任与状态流转

| 适用记录 | 当前缓解与待办 | 责任人 | 目标日期 | 复核日期 | 状态 | 关闭证据 |
|---|---|---|---|---|---|---|
| DEP-001–002 | 核查 MCP 是否启用 Hono 服务端及 WebSocket upgrade；复核代理边界和网络暴露，随后独立升级任务 | hotaru | 2026-11-21（建议） | 2026-11-21 | 待核实 | 待提供 |
| DEP-003–007 | 核查 MCP SDK 实际 Hono 路由、挂载、模板、CSRF 与 form 校验入口；在确认前避免将服务暴露给非可信网络 | hotaru | 2026-11-21（建议） | 2026-11-21 | 待核实 | 待提供 |
| DEP-008–012 | 复核沙箱运行时是否使用对应 forge 功能及可控输入；限制不可信输入与服务暴露，保留进程失败诊断，独立升级并验证沙箱功能 | hotaru | 2026-11-21（建议） | 2026-11-21 | 待核实 | 待提供 |

以上为维护措施与核查清单，尚未验证其阻断全部触发条件。当前没有确认“无上游修复”的条目，也没有因旧漏洞回归测试通过而关闭本次新公告。

状态按“待核实 → 已确认 → 待修复 / 临时例外 → 待验证 → 已关闭”流转。仅有版本命中、override、静态测试或已构建文件均不足以关闭。关闭需记录升级提交、安装包实际位置、受影响入口回归结果与复核人。临时例外须由 hotaru 审核，写明范围、缓解、到期日及复核证据，到期重新打开。高风险项发版前逐项形成结论。

## 维护流程

依赖或锁文件变动、收到公告、准备发布、例外到期时重新采集。保留有效 JSON、退出码、日期、提交与锁摘要。按每个实际版本和依赖路径运行 npm explain。核对 electron-builder 的 files、asarUnpack、extraResources，检查 dist、分发目录和实际 ASAR，再验证输入是否能到达漏洞入口。采集失败写“采集失败”，无法确认入包写“待核实”。本流程使用现有 npm 与打包工具，升级和自动修复须在独立任务进行。


## 构建与分发核查记录

2026-11-14 `npm run build` 退出 0。`dist/main/main/agent/sandbox/sandbox-exec.js` 保留 sandbox-runtime 动态导入，dist 主进程 MCP 模块保留 SDK 引用。本次没有完整 release 分发目录，截图 helper、MinGit 和模型目录内容等打包输入尚未就绪。四实例按配置预计入包，实际 ASAR 路径与调用可达性继续保持待核实。
