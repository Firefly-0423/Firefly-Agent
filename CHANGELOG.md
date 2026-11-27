# 更新日志 / Changelog

- 适用版本：`v1.2.0`（仅涵盖 `v1.1.4` 之后合入 `dev/firefly-1.2.0` 的更新；截至 #152 的条目均已合入并核对。待合入的 #153（流畅吐字）与待提交的修复分支 `fix/code-tool-failure-and-browser-reopen` 仅按当前 PR 描述占位，合并后核对；不包含此前已归入 1.1.x 阶段或未合入 `dev` 的历史条目）。

---

## 1.2.0

### 中文

### 升级须知

- **独立 1.2.0 数据目录，不迁移 1.1.x 旧数据（#62）**：1.2.0 正式版启用独立本地数据目录（`%APPDATA%\Firefly-1.2.0`）并同步更新安装器开机自启配置，不会读取、修改或迁移 1.1.x 版本的对话记录与设置，原有 1.1.x 数据目录将原样保留。

### 新功能

- **全新中性灰黑深色主题，翡翠绿只用于操作（#142、#152）**：#142 首次引入深色翡翠绿方案，#152 在真机验收后将其改写为中性灰黑分层：外框与侧栏 `#181818`、对话区 `#1f1f1f`、卡片与输入框 `#2a2a2a`，边框、悬停与选中态使用白色半透明层，任何表面都不带绿色。翡翠绿（`#10b981`）只保留在发送按钮、主要确认按钮、开关、用户自己的消息气泡与文件名（悬停加下划线），其上的文字为 `#0a0a0a`。活动栏、会话列表与设置导航的选中态改用中性半透明层与普通文字；设置窗口去掉原有的深绿玻璃渐变与强调色光晕，与主窗口一致；表情管理与气泡通知沿用同一套中性令牌。浅色主题与自定义配色（`data-ui-colors`）行为不变。
- **插件全生命周期管理与新版插件市场（#139）**：支持从本地 `.ffplugin`、`.zip` 包或本地文件夹导入 1.2.0 插件；启用前弹窗展示声明的工具、上下文、渠道与权限，提示“启用即信任该插件的代码”，并对 `native: true` 插件展示高风险警示；插件设置内支持中文化权限开关、逐项勾选/取消已声明工具授权与调整模型调用限频（1–60 次/分钟，默认 10 次）。支持同版本覆盖（先停用运行中的旧实例再切换安装目录）、升级激活失败时事务回滚并恢复旧版状态，以及卸载时默认保留密钥与数据（可按需勾选删除，部分清理失败会明确提示）；插件市场切换至 `apiVersion: 2` 目录格式（校验 SDK 版本范围与 SHA-256，并拒绝声明 `native` 的市场包），随应用内置 5 个 v2 离线目录插件供断网时回退安装；同步移除旧版 0.x 插件宿主与面板桥接。
- **聊天定时任务面板支持审阅与确认插件日程提议（#140）**：定时任务面板顶部新增“待确认”区，列出插件提议的新建或变更任务（包含来源插件、标题、计划时间、动作、允许工具以及变更项对照），并通过调度变更事件实时刷新。确认操作绑定审阅时的规格指纹，若插件在用户点确认前修改了提议，确认会被拒绝并提示重新审阅；v2 插件任务统一通过 v2 调度服务执行，面板“立即运行”按宿主实时可运行状态开放，已拒绝或已处理的提议会给出可读提示。
- **插件独立窗口与严格隔离视图（G40、#144）**：声明 `ui.windows` 权限的插件可从管理界面打开独立窗口，通过 `firefly-plugin-ui` 协议与按插件隔离的非持久化会话加载包内静态资源，经已校验的文件句柄读取，路径无法被重定向到包外；会话拒绝所有权限请求与检查，仅暴露最小 `window.fireflyPlugin` 桥接（读取状态、调用、关闭、就绪），并在插件停止、重启、停用、熔断或撤销 `ui.windows` 权限时自动关闭其窗口。
- **插件宿主正式接入桌面应用（#137）**：1.2.0 插件宿主接入应用启动与退出生命周期，状态、授权、递增 `revision` 与限频通过独立 `plugin-state.json` 持久化（文件损坏时保留现场并拒绝继续写入）；首次使用 `sessions.read`、`workspace.read`、`model.run` 时在聊天页或系统对话框发起确认（120 秒超时自动拒绝，刷新页面后可重新加载待确认请求）；插件借用模型期间聊天页显示“〔插件名〕正在借用流萤思考”与停止按钮，传给插件的文本（含流式输出）自动脱敏密钥与受保护路径，并支持工具进度更新与自定义审批说明。
- **插件市场接通 1.2.0 的 v2 目录（#148）**：1.2.0 宿主只支持 v2 插件目录，此前读取的官方地址仍返回 v1；现改为读取 `firefly-plugins` 仓库独立的 `marketplace-v2` 目录，提供五个离线工具及语言学习的 SDK 1.2.0 包。仓库包地址绑定到官方目录、插件 ID 与版本，下载禁止重定向并校验 SHA-256，再交由 v2 导入器验证清单与身份；新装插件默认停用，内置目录可回退。DrawAI 打开、保存与导出所需的宿主文件选择接口尚待接入。

- **提醒小窗内直接查看并处理工具审批（#93）**：在系统提醒小窗点击“查看审批”可展开待确认工具的名称、所属会话、搭档助手与参数摘要，并在核验有效后直接批准或拒绝；即使聊天页面已经切走或刷新，也能从提醒小窗完成确认。
- **任务运行中支持“立即补充”并查看进程内提示气泡（`5f18caa`、#99、#104）**：Work 与 Code 模式任务执行期间，排队消息可标记为“立即补充”或及时撤回（过晚撤回时提示已交给当前运行）；补充内容发往模型时会附带明确提示使其先核对已完成工作再继续，并在任务步骤流中显示为“你补充了”气泡且在刷新后保留位置。
- **Code 模式支持完整读取常见办公与 PDF 文档附件（`5f18caa`）**：在 Work 模式之外，Code 模式现也支持按确认后的读取范围完整读取 `.docx`、`.xlsx`、`.pptx` 与 `.pdf` 附件内容（支持工作区外文件访问档位控制与大文件分段读取提示）。

- **刷新聊天页后仍能找回任务和最终回复（#121）**：页面能识别原任务是否仍在运行或正在收尾，结束后把结果填回原消息。实时输出的接回另行处理。
- **原生 cron 定时计划（#128）**：插件的周期计划可带时区。错过触发、跳过一轮或暂停再恢复后，会排到下一次符合条件的时间。
- **回答均匀吐字，三种模式一致（#153，待合入，合并后核对）**：Chat、Work、Code 的流式回答改为按动画帧均匀放字（每帧最多 4 个字形簇，跨包的 emoji 与组合字符不拆开），流式与结束共用同一棵渲染树、结束不重挂载，未闭合代码块先以等宽纯文本显示；减少动态效果时直接合批，成功收尾快放，切到后台不跑动画但照常结算，取消或出错丢弃未显示正文；滚动由外层独占，用户上滚立即脱钩；并修复以回车、ZWJ 或半个旗帜结尾的文字扣住最后一个字符、堵住后续工具卡与审批的问题。表格改为固定列宽，宽表的表现待真机确认。

### 改进

- **后台任务脱离聊天页面生命周期继续运行（#95）**：任务执行期间切换会话、刷新聊天页或关闭聊天窗口时，后台正在运行的任务不再被意外取消，主进程可继续执行并保存会话轨迹（注：刷新页面后重新接入实时流式输出与浏览器独立跨会话运行能力仍在后续开发计划中）。
- **接管超时提示更明确并支持会话级队列暂停（#91、#102）**：点击“终止并重开”时若旧任务在宽限期内尚未收尾，界面停止无限转圈，明确提示“旧任务尚未停止，未启动新任务”，并仅暂停当前会话的队列自动派发（其他会话不受影响）直到旧任务结算或用户手动重试。
- **打开会话读取插话凭据时不再整份重读运行快照（#107）**：打开包含运行中补充消息的 Work 或 Code 会话时，系统改为直接从内存读取已保存的插话交付凭据，减少大任务记录加载开销。
- **瞬时模型请求限流与网关波动自动退避重试（`432e609`）**：遇到 429 限流、502/503/504 网关异常或 529 过载时自动退避重试（最多两次，取消任务时立即中断等待），减少临时网络或服务波动导致的任务失败。

### 行为变化

- **浏览器页面在切换会话后可以保留（#117、#122）**：运行持有的页面可继续后台只读观察。点击、输入和跳转需等待页面重新可交互。其他会话看不到该页面。
- **文件访问权限收敛到三档（#123）**：只读、请求审批、完全访问。

### 已知限制

- **1.2.0 不支持无人值守运行审批（#140）**：插件定时任务如果会用到命令行（`shell`）、写文件（`fs-write`）、控制键鼠（`input-control`）这类需要每次审批的工具（无论来自插件声明、工具注册表风险推导，还是未知工具按失败闭合处理），在确认提议、启用或编辑并保持启用时都会被直接拒绝，界面提示“1.2.0 还不支持无人值守审批”（完整中文提示：“这个任务每次运行都需要审批，Firefly 1.2.0 还不支持无人值守审批，因此无法确认。”）。此前已经确认过的这类任务到点触发时不会执行，只记一条“跳过”（`skipped`）记录并取消挂起审批，周期任务会被自动暂停。无人值守运行审批入口计划在 1.2.x 提供。
- **外部渠道桌面接入留待 1.2.x（#135、#143）**：SDK 1.2.0 与宿主已提供外部渠道服务，桌面端渠道设置与接入界面留待 1.2.x 提供（当前单会话的 Work 模式切换仅驻留内存，重启后恢复为 Chat）。

### 修复

- **修复项目里上传过附件后，新任务一开始就失败的问题（#112）**：在同一项目中上传过文件后，新开的 Work 或 Code 任务会在读取历史时报错。现在可以正常读取带附件的历史，附件只作为文字记录带入。该问题自 v1.1.4 起存在。
- **真机验收修复（#150）**：气泡通知小窗的头像因目录未列入打包路径而无法显示，现已正常显示；插件卡片的版本、来源与重启提示行改用与开发者行一致的小字样式；插件升级失败时界面显示中文的“插件自身报错：…”（取首行、不含堆栈、路径已替换、最多 160 字）而不再是“Internal plugin error”，回滚成功后该错误只在顶部提示条显示一次、不再固定在卡片上；覆盖安装确认框按“已安装/将安装”、提示、权限变化与工具列表分段排版，确认对话框保留换行；已撤销授权的插件工具不再出现在模型可见的工具列表中（执行时的权限检查仍保留）。
- **待提交：修复 Code 模式工具调用失败与浏览器面板需双击才能重新打开（`fix/code-tool-failure-and-browser-reopen`，待合入，合并后核对）**：占位条目，涉及 Code 模式工具调用报错 `E_TOOL_EXECUTION_FAILED` 与右侧浏览器面板关闭后需点击两次才能重新打开；具体改动待该分支合入后按 PR 描述录入。
- **修复插件示例正常停止后丢失状态的问题（#111）**：示例插件停止再启动后会保留之前保存的状态。
- **修复 Chat 误入计划模式的问题（#108）**：普通聊天不再接收计划审批，也不会因为旧的计划批准而自动发出下一条消息。
- **修复主窗口仅失焦时右侧浏览器变空白的问题（#106）**：截图（如 `Win+Shift+S`）或切换到其他程序导致主窗口失去焦点但仍可见时，右侧内置浏览器保留当前网页画面不再空白；仅在窗口隐藏、最小化或切换会话时才收起视图（恢复焦点后仍需重新读取页面才会继续代理操作）。
- **修复任务结束存档失败时清空回答或误报已保存的问题（#90）**：将任务结果判定与终态落盘拆分，写入失败时最多自动重试三次，确认存盘成功才返回已保存状态；即便写盘持续失败也保留屏幕上的已生成回答并提醒未保存。
- **修复被中断任务的旧工具调用行一直显示“等待中”的问题（#100）**：重新打开此前意外中断的会话时，当时仍停留在进行中的工具步骤（例如等待用户回答的澄清提问）会自动展示为已结束（“上次运行已中断”），不改写历史记录也不重放工具。
- **修复运行中插话写入异常时丢失或错位重放的问题（#97）**：调整写入顺序为先确认提交聊天历史再落会话记录，避免同一批补充部分失败时丢失前面已写条目，或在后续新回合误把半截未显示的记录送给模型。
- **修复审批弹窗跨会话误投问题（#92、#93）**：严格按运行归属路由工具审批，禁止把找不到原运行的审批卡错塞进当前正打开的其他会话窗口。
- **修复运行被占用拒发消息误记成功及微信无效消息异常（#82、#102）**：当因旧任务仍在收尾而拒绝直接发送时，新消息不再被错误标记为已发送而悄无声息丢失；同时丢弃缺少发送者标识的微信异常轮询消息，避免连带报错或泄露内容。

- **长附件阅读提示更清楚（#118）**：Chat 无法完整读取长附件时，提示改用 Work。
- **文档索引恢复可用（#116）**：修复文档检索服务因为无法启动而不能建立索引的问题。
- **设置页可用 Esc 关闭模型候选，放弃编辑会重置提示（#120）**。

### 插件 SDK

- **SDK 1.2.0 开发者文档与可执行示例测试（#143）**：重写 `plugin-sdk/README.md`、`plugin-sdk/LIFECYCLE.md`、`docs/plugins/plugin-authoring.md` 与 `docs/plugins/plugin-dev-guide.md` 并更新发布标签说明，补充桌面通知、外部渠道规则、`model.run` 拒绝需审批动作（不弹审批卡、不挂起、不静默放行）、免打包最小示例与 esbuild 打包说明，并新增由 `createTestHost` 自动校验执行的 Markdown 文档示例测试。
- **插件桌面通知能力（#136、#139）**：新增 `notifications` 权限与 `ctx.notifications.show({ title, body })`，仅接受纯文本（标题 ≤ 64 码点、正文 ≤ 256 码点，自动清除控制与双向覆盖字符），每插件每分钟限频 5 次（重启不重置），宿主自动附加真实插件名前缀 `〔插件名〕`，点击仅聚焦主窗口，停用或撤权时关闭待显示通知；桌面宿主启动组装已接入（`plugin-v2-bootstrap.ts`），Windows 实机效果待打包验收。
- **外部渠道宿主服务（#135）**：新增 SDK 1.2.0 外部渠道宿主服务，支持已声明渠道注册、入站消息排队（单会话最多 20 条）、内联附件限制（最多 8 个、总计 10 MB，不抓取远程 URL）、`<external-data>` 不可信包裹、默认 Chat 无工具与单会话 Work 仅放行 `fs-read` 工具、仅限本机审批与出站脱敏；桌面端界面随 1.2.x 提供。
- **官方 1.2.0 示例插件（#133）**：在 `plugin-sdk/examples/` 新增天气查询（`dev.firefly.weather`）与每日提醒（`dev.firefly.reminder`）两个示例插件，覆盖网络工具、密钥存取、设置页界面、定时任务提议、通知发送与 `createTestHost` 单测及打包冒烟脚本。
- **插件可申请模型和只读数据能力（#132）**：宿主支持文本生成和完整运行，默认每个插件两项模型能力合计每分钟 10 次。会话和工作区访问需要授权，工作区接口只给绑定信息；桌面宿主接线见 #137，管理与启用入口见 #139。

- **插件开发与授权（#129、#131）**：SDK 提供插件公开接口、测试宿主和运行入口。插件工具按风险和授权使用，插件提供的上下文按不可信资料处理；桌面接线与管理界面见 #137、#139，最终能力以打包实机验收为准。

- **密钥、定时任务与插件进程（#124–#127）**：提供按插件隔离的加密密钥存储、需要确认的定时任务、清单与打包检查，以及独立插件进程。具体插件能使用的能力取决于声明和用户授权。

### 工程与文档

- **打包应用插件冒烟验证脚本（G45、#145）**：新增 `scripts/verify/packaged-plugin-smoke.mjs` 及隔离守卫单测，使用临时目录内的独立隔离根（`--firefly-profile` / `--firefly-isolation-root`，拒绝生产数据目录），仅按 PID 清理自己启动的进程，通过 CDP 驱动并覆盖插件流程；脚本本身需在打包版上由真机验收执行（开发构建 `--dry-run` 已验）。
- **清理代码、计划与文档中的历史参考与上游项目名称（#141）**：统一改写计划、规格、CI 工作流注释及少量代码片段表述（涉及侧边栏、聊天页、天气工具与测试夹具等），无用户侧行为变化。
- **渲染进程颜色令牌收敛（#134）**：将 38 个 CSS 文件中的 662 处静态色值收敛至 `src/renderer/ui/tokens.css`（零视觉变化），为 #142 深色主题改版提供统一变量入口。
- **精简中英文 README 与更新源码搜索忽略规则（#119、#138）**：改版 `README.md` 与 `README.en.md`（改用应用头像图标、新版徽章与精简章节，并指向 `docs/README.md` 和 `AGENTS.md`）；扩展 `.ignore` 过滤锁文件、`vendor/`、Live2D 与图片资源，让代码搜索聚焦源码。
- **按 1.2.0 重写中英文 README（#149）**：按首次了解、安装、插件开发与贡献的顺序重排；徽章仅保留 GitHub 与 GitCode（GitCode 镜像在 1.2.0 发布后同步）；新增下载安装（含独立的 `%APPDATA%\Firefly-1.2.0` 数据目录）、1.2.0 变化与已知限制（高风险插件日程在确认时被拒绝，无人值守运行审批与桌面渠道界面随 1.2.x 提供）；移除项目结构表，开发者改看 `docs/contributing/`；不含上游项目名称。
- **许可证单一版权人与第三方声明（#146）**：`LICENSE` 改为单一版权人行 `Copyright (c) 2026 Firefly-0423`；`THIRD_PARTY_NOTICES.md` 新增早期发布内容一节，说明 1.1.x 及之前版本和相关仓库历史含改编自另一 MIT 许可项目的代码并保留其版权行，1.2.0 本身不再包含该代码；同时重写 `src/plugins/v2/ui/assets.ts` 中最后一处与上游相近的内容类型表和路径段检查（行为不变，并补充编码路径段表驱动测试）。
- **法律与声明文档移入 `legal/`（#151）**：`THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_SKILL_REVIEWS.md`、`MODEL_LICENSE.md` 与三语免责声明移入顶层 `legal/`，`LICENSE` 仍在根目录；README、文档、站点构建配置与命令行横幅中的链接同步修正；`electron-builder.yml` 仅改来源路径，安装包内目标位置不变，声明文件仍随安装包放在 `legal/` 下。

- **设置页继续按面板拆分（#110、#114）**：通用、偏好、外观和 API 面板各自成为独立模块，设置页入口收敛到约 110 行，冷启动读取次数不变。
- **仓库开发和构建改用 pnpm 12.10.1（#109）**：依赖安装、脚本和 CI 统一使用 pnpm；插件 SDK 仍通过 npm 发布。
- **Vite 与 Vitest 配置改用 `.mts`（#115）**：配置文件改为 ESM；Code 模式的文件工具和语言服务同步识别 `.mts` 为 TypeScript。
- **主进程七层架构重构与持久边界守护（#57、#58、#59、#60、#67–#69、#75）**：完成主进程自底向上七层重组、记忆与运行子模块内部定序、循环引用清理与未引用模块移除，并将全部主进程日志收敛至统一日志通道，通过自动化架构测试长期守住引用方向及测试代码与生产编译隔离。
- **预加载桥接、设置页拆分与事件退订统一（#66、#73、#74、#76–#78、#85–#87）**：先补全契约测试再将预加载入口与设置页主模块按职责拆分为独立工厂与子模块，并统一预加载侧 IPC 监听器的退订调用方式（#76）。
- **测试断言规范化与核心回归验收体系加固（#64、#65、#72、#79–#81、#83、#88、#89、#91）**：围绕安全拒绝、记忆上下文、渠道请求与运行恢复加固错误码与副作用断言，建立涵盖并发接管与队列派发的聊天页回归用例库。
- **开发基线升级、诊断收敛与文档体系整理（#61、#63、#70、#71、#84、#94、#98、#101）**：将开发与构建基线升至 Node.js 24+（#61）；统一二级记忆激活状态存储大小写（#71）；将一次性历史预算诊断开关限定在开发构建启用（#70）并支持通过环境变量覆盖验证驱动的输出基目录（#84）；整理分类无日期化项目文档、免责声明与浏览器拆分定稿设计（#98，其剩余隔离能力待后续开发）。

---

### English

### Upgrade Notice

- **Isolated 1.2.0 user data directory with no automatic 1.1.x migration (#62)**: Firefly 1.2.0 stores its production conversations, settings, and installer autostart options in a dedicated folder (`%APPDATA%\Firefly-1.2.0`). Existing 1.1.x data directories are never read, altered, or migrated automatically and remain intact.

### New Features

- **Neutral grey-black dark theme with emerald only on actions (#142, #152)**: #142 first introduced the emerald dark scheme; after the real-machine test #152 rewrites it as neutral grey-black layers: frame and sidebars `#181818`, conversation area `#1f1f1f`, cards and inputs `#2a2a2a`, with white translucent veils for borders, hover and selection and no green tint in any surface. Emerald (`#10b981`) stays only on the send button, primary confirm buttons, toggles, the user's own message bubble and file names (underlined on hover), with `#0a0a0a` labels on it. Selected rows in the activity bar, session list and settings navigation use a neutral veil with normal text; the settings window drops its dark-green glass gradient and accent glow to match the main window; the sticker manager and toast follow the same neutral tokens. The light theme and custom colors (`data-ui-colors`) keep their behavior.
- **Full v2 plugin lifecycle management and apiVersion 2 marketplace (#139)**: Adds local `.ffplugin`, `.zip`, and folder imports, an enable trust confirmation dialog listing declared tools, context, channels, and permissions (with a high-risk warning for `native: true`), and per-plugin settings with localized permission toggles, individual tool grant checkboxes, and model rate-limit controls (1–60/min, default 10). Supports same-version overwrite (stopping the running instance before swapping files), transactional rollback on upgrade activation failure, and selective uninstall (keeping secrets and data by default with opt-in deletion and partial-cleanup failure reporting). Updates the marketplace to `apiVersion: 2` (SemVer SDK check, SHA-256 verification, rejecting `native` marketplace packages), bundles 5 v2 offline catalog plugins for network-offline fallback, and removes the legacy 0.x plugin host and panel bridge.
- **Review and confirm or reject plugin schedule proposals in chat (#140)**: Adds a pending-confirmation section at the top of the scheduled-task panel showing plugin-proposed creates and updates (plugin name, title, schedule, action, allowed tools, and diffs against the live schedule) with live updates via scheduler change events. Confirmations bind to the reviewed spec revision (rejecting confirmation with a re-review prompt if the plugin edits the proposal before confirmation), v2 plugin tasks execute through the v2 schedule service, the panel's "Run now" action reflects v2 host runnable state, and already-handled or rejected proposals display readable errors.
- **Isolated plugin UI windows (G40, #144)**: Plugins declaring `ui.windows` can open isolated windows from the management UI over a custom `firefly-plugin-ui` protocol and per-plugin non-persistent sessions, with assets read through verified file descriptors so a read cannot be redirected outside the package; the session denies every permission request and check, a minimal `window.fireflyPlugin` bridge exposes only get state, invoke, close and ready, and a plugin's windows close when it stops, restarts, is disabled, faults or loses `ui.windows`.
- **SDK 1.2.0 plugin host wired into the desktop app (#137)**: Wires v2 plugin startup/shutdown into the desktop composition root with persistent `plugin-state.json` storage (preserving corrupt files and refusing further writes), first-use confirmations for `sessions.read`, `workspace.read`, and `model.run` (120 s timeout, recoverable after renderer reload), a chat banner ("〔plugin〕正在借用流萤思考") with a Stop button while a plugin borrows the model, secret/protected-path redaction on text sent to plugins (including streams), and tool progress / `describeApproval` support.
- **Plugin marketplace connected to the 1.2.0 v2 catalog (#148)**: The 1.2.0 host only supports v2 plugin catalogs, but the official address it read still returned v1; it now reads the separate `marketplace-v2` catalog in the `firefly-plugins` repository, which provides five offline tools and a language-learning plugin built for SDK 1.2.0. Package URLs are bound to the official catalog, plugin ID and version; downloads forbid redirects and verify SHA-256 before the v2 importer checks the manifest and identity; new installs stay disabled and the bundled catalog remains the fallback. The host file-picker interface that DrawAI needs for open, save and export is not wired yet.

- **Review and answer tool approvals directly from the reminder toast (#93)**: Clicking "View approval" in a toast reminder inspects the pending tool, target session, partner agent, and arguments after Main verifies the request, letting you approve or deny even if the main chat view switched or reloaded.
- **In-run "Send Now" supplements with live process bubbles (`5f18caa`, #99, #104)**: In Work and Code modes, queued messages can be marked to inject mid-run or withdrawn before handoff (with a notice if already handed off). Injected messages include a clear prompt note so the model reviews finished work first, appear in the step stream as "你补充了" bubbles, and keep their position across reloads.
- **Full Office and PDF attachment reading in Code mode (`5f18caa`)**: Extends confirmed full-text reading for `.docx`, `.xlsx`, `.pptx`, and `.pdf` attachments into Code mode alongside Work mode.

- **Find the original task and reply after refresh (#121).** The page recognizes an active or settling task and fills in its final reply when saved. Live streaming reattachment is separate.
- **Native cron schedules (#128).** Recurring plugin schedules support time zones and advance after missed runs, skips or a pause.
- **Evenly paced streamed text in all three modes (#153, pending merge, verify after merge)**: Streamed answers in Chat, Work and Code are released per animation frame (at most 4 grapheme clusters per frame, never splitting emoji or combining sequences across chunks), streaming and the final render share one tree so finishing does not remount, and an unclosed code block shows as monospace plain text first. Reduced motion batches directly, a successful finish flushes quickly, a background tab skips animation but still settles, and cancel or error discards undisplayed text; scrolling belongs to the outer container and detaches as soon as the user scrolls up; text ending in CR, ZWJ or half a flag no longer holds back its last character and blocks later tool cards or approvals. Tables now use fixed column widths; how wide tables look is pending real-machine confirmation.

### Improvements

- **Background tasks continue when switching chats, refreshing, or closing the window (#95)**: Desktop runs now retain independent execution authorization and finish safely in the background without accidental cancellation (note: reattaching live streaming output after a page reload and cross-session browser isolation remain under active development).
- **Clearer takeover timeout feedback and session-scoped queue pause (#91, #102)**: If stopping a busy run times out, the takeover button stops spinning, a banner explains that the prior task has not yet finished, and auto-dispatch pauses only for that session until settlement or manual retry.
- **In-memory lookup for run insertion receipts when opening sessions (#107)**: Opening Work or Code sessions now reads saved insertion delivery receipts from memory instead of reloading every full run snapshot file.
- **Automatic backoff retry on transient model HTTP errors (`432e609`)**: Requests rejected with 429 rate limits, 502/503/504 gateway errors, or 529 overload automatically retry up to twice while honoring immediate user cancellation.

### Behavior Changes

- **Browser pages can survive a conversation switch (#117, #122).** A run can observe its page in the background. Clicks, typing and navigation wait until the page is interactive again. Other conversations cannot see that page.
- **Three file access levels (#123).** Choose read-only, ask for approval or full access.

### Known Limitations

- **Unattended run approval is not supported in 1.2.0 (#140)**: Plugin scheduled tasks that require per-run approval tools (`shell`, `fs-write`, or `input-control` — whether declared, derived from the tool registry, or treated as fail-closed for unknown tools) are rejected when confirming a proposal or enabling/editing a task to stay enabled, showing the UI notice that Firefly 1.2.0 does not support unattended run approval yet (Chinese UI: "1.2.0 还不支持无人值守审批"). Previously confirmed tasks of this kind do not execute when triggered; they record a single `skipped` history entry, cancel waiting approvals, and pause recurring schedules. An approval UI for unattended runs is planned for 1.2.x.
- **External channel desktop UI deferred to 1.2.x (#135, #143)**: SDK 1.2.0 and host channel services are available, while desktop channel configuration and wiring UI are planned for 1.2.x (per-conversation Work mode switches currently remain in memory and reset to Chat on restart).

### Bug Fixes

- **Fixed new tasks failing at start in projects that had attachments (#112)**: After a file was uploaded in a project, new Work or Code tasks there failed while reading history. History with attachments now loads, with attachments carried as text records only. The issue existed since v1.1.4.
- **Real-machine test fixes (#150)**: The toast window avatar failed to load because its directory was missing from the packaged path list and now shows; plugin card version, source and restart lines use the same caption style as the developer line; a failed plugin upgrade shows a Chinese "插件自身报错：…" message (first line, no stack, paths replaced, up to 160 characters) instead of "Internal plugin error", and after a successful rollback the error appears once in the banner and is no longer pinned on the card; the replace-install confirmation is laid out in sections (installed/incoming, notices, permission changes, tool list) and confirm dialogs keep line breaks; tools of a plugin whose grant was revoked no longer appear in model-visible tool lists (the execution-time permission check stays).
- **Pending: Code-mode tool failure and browser panel needing two clicks to reopen (`fix/code-tool-failure-and-browser-reopen`, pending merge, verify after merge)**: Placeholder covering Code-mode tool calls failing with `E_TOOL_EXECUTION_FAILED` and the right-hand browser panel needing two clicks to reopen after being closed; concrete changes will be recorded from the PR description once the branch is merged.
- **Fixed plugin examples losing their state after a normal stop (#111)**: Example plugins keep their saved state when stopped and started again.
- **Fixed Chat entering plan mode (#108)**: Ordinary chats no longer accept plan approvals, and an old plan approval no longer sends a follow-up message.
- **Fixed right-hand browser going blank when the main window only loses focus (#106)**: Taking screenshots (e.g. `Win+Shift+S`) or switching to another app no longer clears the visible right-hand browser pane; the view now detaches only on minimize, hide, or session switch (agent interactions still wait until focus returns and the page is re-observed).
- **Fixed terminal persistence failures clearing answers or issuing false save receipts (#90)**: Separates run completion from saving, retries failed disk writes up to three times before reporting persistence, and keeps generated answers on screen with an unsaved notice if writes fail.
- **Fixed interrupted runs leaving tool rows stuck spinning on reopen (#100)**: Reopening a previously interrupted chat renders leftover running tool steps (such as clarification prompts waiting for input) as ended ("上次运行已中断") in the UI without modifying stored records or replaying tools.
- **Fixed mid-run message insertions being lost or replayed out of turn (#97)**: Commits insertions to chat history before writing model transcripts so partial write errors neither discard committed supplements nor replay hidden fragments in later runs.
- **Fixed approval routing leaks across conversations (#92, #93)**: Prevents unowned or detached approval cards from falling back into whichever unrelated conversation happens to be visible.
- **Fixed busy-rejected messages silently dropping & malformed WeChat inbound items (#82, #102)**: Ensures submissions refused due to an active run stay interrupted/pending rather than marked sent, and safely discards WeChat polled messages lacking sender IDs without leaking details.

- **Clearer long attachment guidance (#118).** Chat recommends Work when it cannot read a long attachment in full.
- **Document indexing works again (#116).** Fixes a startup failure that prevented document indexes from being built.
- **Model picker and discard behavior in Settings (#120).** Escape closes the picker, and discarding edits resets the status.

### Plugin SDK

- **Rewritten 1.2.0 SDK docs with executable doc-example tests (#143)**: Rewrote `plugin-sdk/README.md`, `plugin-sdk/LIFECYCLE.md`, `docs/plugins/plugin-authoring.md`, and `docs/plugins/plugin-dev-guide.md`, updated the publishing tag guide, documented desktop notifications, external channel rules, `model.run` approval refusal, and a bundle-free minimal example plus esbuild bundling, and added `createTestHost`-backed tests executing the Markdown code examples.
- **Desktop notifications capability for plugins (#136, #139)**: Added the `notifications` permission and `ctx.notifications.show({ title, body })` with plain-text sanitization (64/256 code-point limits), a 5/min per-plugin sliding rate limit, host-enforced `〔plugin〕` title prefixing, focus-only clicks, and automatic dismissal on disable or revocation; the desktop host bootstrap wiring is in place (`plugin-v2-bootstrap.ts`), with the Windows real-machine check pending.
- **Host channel services for SDK 1.2.0 (#135)**: Added manifest-declared channel registration, inbound queuing (20 messages per conversation), inline attachment caps (up to 8 files / 10 MB total, no remote URL fetches), `<external-data>` untrusted wrapping, Chat (no tools) and Work (`fs-read` only) modes, local-only approvals, and mandatory outbound redaction; desktop UI follows in 1.2.x.
- **Official 1.2.0 example plugins (#133)**: Added `dev.firefly.weather` and `dev.firefly.reminder` under `plugin-sdk/examples/` covering network tools, secret storage, settings UI, schedule proposals, notifications, `createTestHost` tests, and packaged SDK smoke validation.
- **Model and read-only data services for plugins (#132).** The host supports text generation and full runs, with a shared default limit of 10 model requests per plugin per minute. Session and workspace access require consent. Workspace APIs expose binding information. Desktop host wiring is covered in #137 and management UI in #139.

- **Plugin development and consent (#129, #131).** The SDK adds public APIs, a test host, and a plugin runtime. Tool access depends on risk and user consent; plugin context is treated as untrusted data. Desktop wiring and lifecycle UI are covered in #137 and #139, subject to real-machine acceptance.

- **Secrets, schedules and plugin processes (#124–#127).** Adds encrypted per-plugin secret storage, schedules that require confirmation, manifest and package checks, and separate plugin processes. Capabilities depend on declarations and user authorization.

### Engineering & Docs

- **Packaged plugin smoke verification script (G45, #145)**: Added `scripts/verify/packaged-plugin-smoke.mjs` and isolation-guard unit tests. It starts the packaged app with an isolated profile and root in a temporary directory (`--firefly-profile` / `--firefly-isolation-root`, refusing production data directories), drives it over CDP, exercises the plugin flows, and stops only the processes it started; the script itself runs against a packaged build during the real-machine check (`--dry-run` verified on a dev build).
- **Upstream project reference cleanup (#141)**: Removed remaining upstream project references from plans, specs, and CI comments and restructured minor code fragments (sidebar, chat page, weather tool, test harness) with no user-facing behavior change.
- **Centralized renderer color tokens (#134)**: Moved 662 hard-coded color values across 38 CSS files into `src/renderer/ui/tokens.css` with zero visual change as groundwork for #142.
- **Concise README overhaul and `.ignore` update (#119, #138)**: Rewrote `README.md` and `README.en.md` around the app avatar, new badges, and shorter sections linking to `docs/README.md` and `AGENTS.md`; expanded `.ignore` to skip lockfiles, `vendor/`, Live2D assets, and binary images during code search.
- **README rewrite for 1.2.0 (#149)**: Reordered for first-time readers, then installers, then plugin authors and contributors; badges are limited to GitHub and GitCode (the GitCode mirror is populated after the 1.2.0 release); adds download and install (including the separate `%APPDATA%\Firefly-1.2.0` data directory) and 1.2.0 changes and known limits (risky plugin schedules are refused at confirmation; unattended run approval and the desktop channel UI come in 1.2.x); removes the project-structure tables in favor of `docs/contributing/`; no upstream project names.
- **Single licence holder and third-party notices (#146)**: `LICENSE` now carries the single holder line `Copyright (c) 2026 Firefly-0423`; `THIRD_PARTY_NOTICES.md` gains a section for earlier releases explaining that 1.1.x and earlier releases and the repository history contain code adapted from another MIT-licensed project whose copyright line is kept, while 1.2.0 itself no longer contains that code; the last similar content-type table and path-segment check in `src/plugins/v2/ui/assets.ts` is rewritten with the same behavior plus a table test for encoded segments.
- **Notices, model licence and disclaimers moved into `legal/` (#151)**: `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_SKILL_REVIEWS.md`, `MODEL_LICENSE.md` and the three-language disclaimers move into a top-level `legal/` folder (`LICENSE` stays at the root); links in the READMEs, docs, site build config and CLI banner are updated; `electron-builder.yml` changes only its `from:` sources, so the installer still ships the notices under `legal/` with an unchanged installed layout.

- **Settings page split into per-panel modules (#110, #114)**: General, preferences, appearance and API panels are now separate modules; the entry shrinks to about 110 lines with the same cold-start reads.
- **Development and builds now use pnpm 12.10.1 (#109)**: Installs, scripts and CI use pnpm; the plugin SDK is still published with npm.
- **Vite and Vitest configs moved to `.mts` (#115)**: The configs are ESM files, and Code mode's file tools and language server treat `.mts` as TypeScript.
- **Main-process 7-layer reorganization and automated dependency guardrails (#57, #58, #59, #60, #67–#69, #75)**: Reorganized `src/main` into strict upward-forbidden layers with sub-module ordering, broke circular imports, removed unreferenced modules, centralized main logging, and isolated test helpers from production builds.
- **Preload bridge & Settings page modularization and listener cleanup (#66, #73, #74, #76–#78, #85–#87)**: Added contract tests and split the preload bridge and Settings entrypoints into focused factories/helpers while standardizing preload IPC listener removal on `removeListener` (#76).
- **Hardened error-code assertions and ChatPage regression coverage (#64, #65, #72, #79–#81, #83, #88, #89, #91)**: Strengthened unit/integration assertions across security, permissions, memory, channels, and agent modules and established regression suites for persistence, takeover, and queueing.
- **Toolchain baseline, diagnostic tightening & documentation overhaul (#61, #63, #70, #71, #84, #94, #98, #101)**: Updated toolchain support to Node.js 24+ (#61); standardized lowercase L2 memory activation state persistence (#71); restricted legacy budget diagnostic switches to dev builds (#70) with env-overridable verify driver base directories (#84); categorized undated project docs and finalized the browser owner/session split design (#98, implementation remaining).

---
