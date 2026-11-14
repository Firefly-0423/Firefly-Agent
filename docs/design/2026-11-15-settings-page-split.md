# `settings.ts` 拆分设计文档

- 状态：设计已由负责人确认（2026-11-15）
- 日期：2026-11-15
- 依据提交：`a96f254`
- 负责人：`hotaru`

> **范围说明**：本文档仅设计 `src/renderer/settings/settings.ts`（当前 1629 行，约 70 条导入）的职责拆分、边界收敛、测试补齐与分批合入方案；不修改已拆出的独立面板内部实现（`channels/`、`email/`、`mcp/`、`plugins/`、`rag/`、`search/`、`timeout/`、`usage/`、`user/`、`preferences/panel.ts` 等），仅收口仍残留在 `settings.ts` 中的对应胶水代码。

---

## 1. 现状：它承担了哪几件事

在提交 `a96f254` 中，设置页早先已陆续拆出 `./email/panel`、`./search/panel`、`./user/panel`、`./plugins/panel`、`./plugins/permission`、`./rag/panel`、`./preferences/panel`、`./mcp/panel` 等纯副作用面板（`settings.ts:61-70`），以及 `api/state.ts`、`api/provider-editor.ts`、`shared/navigation.ts`、`shared/shell.ts`、`appearance/colors.ts`、`appearance/advanced.ts` 等辅助模块。但 `settings.ts` 仍作为超级入口保留了 **9 类职责** 与 **3 处历史拆分遗留胶水**。

### 1.1 职责分组清单

| 职责分组 | 关键函数 / 常量与行号范围 | 管理的状态 | 读写的 `window.*` 接口 |
| --- | --- | --- | --- |
| **A. 浏览器预览兜底与死常量** | 死常量 `MIMO_ICON_URL`（L82，全仓无引用）；`unavailableSettings` / `emptyList` / `emptyObject` / `noSubscription`（L84–88）；`previewSearchSettings`、`previewEmailSettings`（L90–104）；`window.settings` 兜底（L106–196）；`window.fireflyScheduler` 兜底（L198–212）；`declare global { interface Window }`（L74–80） | 无独立状态（按需注入全局 mock 对象） | 初始化/覆写 `window.settings`、`window.fireflyScheduler` |
| **B. 窗口壳层、导航路由与全局 UI 增强** | `NAV_LABELS`（L214–231，模块求值期调用 `t()`）；`minBtn` / `closeBtn`（L233–234）；`navigationButtons` / `panelSections`（L1309–1310）；懒加载 `loadUsage`（L1313–1318）、`loadSubagents`（L1321–1326）；`switchSection`（L1328–1376）；`bindSettingsNavigation`（L1378）；`mountSettingsSearch` + `subscribeLocaleChanged` 刷新索引（L1380–1390）；启动序列（L1402–1408）；`openSection` + `location.hash` + `onSwitchSection`（L1409–1415）；`attachDatePicker` / `enhanceSelects` / `trackRangeFills`（L1465–1468） | `navigationButtons` / `panelSections`；动态 `import("./usage/panel")` 与 `import("./api/agent-routing")` | `window.settings.minimize()` / `close()` / `onSwitchSection()` / `onChannelsStatusChanged()` |
| **C. 选项按钮组通用 DOM 工具** | `markChoice`、`selectButtons`、`applyOptionGroupValue`、`getOptionGroupValue`（L250–269）；`onChoice`（L830–834） | 无（纯 DOM 选中态读写） | 无 |
| **D. 外观与桌面宠物设置（`appearance`）** | `uiColorControls = bindUiColorControls(...)`（L236）；`saveAppearancePatch`（L238–248）；`renderUiFont`（L300–305）；`pixelSizeInputs` / `pixelSizeRanges` / `savedChatAppearance` / `appearanceAdvanced`（L308–324）；`renderChatAppearanceControls`（L326–339）；`bindPixelSizeInput`（L341–363）；`renderUiTheme` / `renderUiIcon`（L365–371）；`restorePetAndAppearance`（L773–783）；字体/宠物/主题/图标/滑条监听（L849–933）；`appearanceForm` submit 拦截（L1140） | `savedChatAppearance`（ChatAppearanceSettings 快照）、`uiColorControls` 闭包状态与 `appearanceAdvanced` 闭包状态 | `saveGeneral`、`pickUiFont`、`importUiFont`、`resetUiFont`、`setPetAlwaysOnTop`、`setPetVisible`、`setPetZoom`（经 `loadGeneralSettings` 读 `getGeneral`） |
| **E. 通用与桌面开关（`general`）** | `UiLanguage`、`normalizeUiLanguage`、`applyLanguageSelection`（L284–288）；语言卡片点击保存（L1143–1154）；`setDesktopSaveStatus`（L1157–1161）；`bindDesktopSwitch`（L1163–1177，管理 `toastSoundEnabledInput` 与 `launchAtLoginInput`）；`[data-app-version]` 读取版本（L1180–1184） | 各自开关的 `previous` 回滚值、`desktopSaveStatus` 文案 | `saveGeneral`、`window.appUpdate?.getState()`（经 `loadGeneralSettings` 读 `getGeneral`） |
| **F. 聊天偏好与主动触达（`preferences`）** | `applyProactiveChatSelection` / `applyProactiveDeliverySelection` / `getProactiveChatValue` / `getProactiveDeliveryValue`（L290–293）；`renderProactiveDeliveryVisibility`（L295–298）；`restoreChatPreferences`（L785–791）；`dirtyPreferences`（L828）；选项点击（L935–944）；开关 change 与 `bindSettingsSubmit(preferencesForm, ...)`（L1620–1629） | `dirtyPreferences`（未提交态标记，实际通过提示函数回调体现） | `saveGeneral`、`channelsGetStatus`（配合 `renderProactiveDeliveryAvailability`）、`onChannelsStatusChanged`（经 `loadGeneralSettings` 读 `getGeneral`） |
| **G. Firefly 贴纸与向量维度（`firefly`）** | `stickerSize` / `getStickerSizeValue` / `applyStickerSizeSelection`（L271–282）；`syncStickerSendStatus`（L822–825）；`dirtyStickers`（L827）；贴纸控件监听（L836–847）；`embeddingDimensions`（L1199–1204）；`bindSettingsSubmit(fireflyPanel, setFireflySaveStatus, ...)`（L1205–1213） | `dirtyStickers`（未提交提示回调） | `saveConfig`（经 `restoreModelSettings` / `loadConfig` 读 `getConfig`） |
| **H. API 档案、Endpoint、拉取模型、测试连接与高级超时（`api` + `api-advanced`）** | 预设图标与列表：`presetLogo`、`fillPresetOptions`、`setActivePresetCard`、`findPreset`（L373–420）；输入模态与模型Picker：`inputModalities`（L424–430）、`fetchedInputModalities` / `fetchModelsGeneration` / `closeFetchedModelPicker` / `fillModelSuggestions` / `fillModelOptions`（L432–456）；档案草稿与列表：`isCurrentProfilePanel`（L463–465）、`profileDraftSnapshot` / `hasUnsavedProfileDraft` / `updateProfileDraftState`（L473–506）、`changeProfileEditor` / `renderProfileList` / `reloadProfiles` / `applyEditingStateUI` / `syncCustomEndpointControlsVisibility` / `editProfile` / `startNewDraft`（L509–623）；Endpoint/Transport：`getCurrentModelValue` / `getApiKeyForRequest` / `validateActiveCustomEndpoint` / `updateEndpointPreview` / `applyCustomEndpointUI` / `presetAddress` / `showPresetWebsite` / `applyPreset`（L626–732）；配置恢复：`restoreModelSettings` / `loadConfig`（L734–771）、`bindExclusiveToggle`（L814–820）；Work-Flow 弹窗（L949–994）；`testActiveConnection`（L996–1034）、`bindReasoningLevels()`（L1036）；`modelPicker` / `fetchModelsErrorText` / `fetchModelsBtn`（L1039–1098）；`baseUrlResetBtn` / `changeTransport`（L1100–1127）；`apiRuntimeForm` submit（L1129–1139）；`apiForm` submit（L1215–1307）；`attachCardSelect`（L1448–1463）、`chooseProvider` / `chooseEndpointMode` / `profileList` / `deleteProfile` / `requestDeleteProfile` / `addProfile` / `closeProfileEditor` / `selectProviderTab` / `apiForm` input / `translateProviderUi` & `subscribeLocaleChanged`（L1470–1618） | `./api/state.ts` 的 `apiState`；模块顶层 `profileDraftBaseline`、`profileTransitionPending`、`profileSavePending`、`profileEditorReturnProfileId`、`profilePendingButtons`（L467–471）；`fetchedInputModalities`（L432）；`fetchModelsGeneration`（L433） | `getConfig`、`saveConfig`、`getModelProfiles`、`saveModelProfile`、`deleteModelProfile`、`testConnection`、`fetchModels`；跨面板调用 `saveTimeoutSettings`（`timeout/panel.ts`） |
| **I. 历史拆分遗留胶水（孤儿绑定）** | Scheduler：`schedulerClicks` / `schedulerKindInput` / `schedulerToolLimitInput`（L1392–1400）；Memory：`removeImportedDocument` / `memoryImportedList` 点击委托（L1417–1440）；Music：`#music-platform-qq` 点击切换 `"music"`（L1442–1445） | 无 | `memoryPanel.deleteImportedDoc`（`memory`） |

### 1.2 跨组依赖、共享变量与耦合点

1. **单次读取、多域分发的数据扇出（Fan-out）**：
   - `loadConfig()`（L748–771）：发起一次 `getConfig()` 与 `getModelProfiles()`，在 `restoreModelSettings()`（L734–746）里同时填充 **API 预设与全局开关**（`thinkingOverride`、`disableMaxToken`）以及 **Firefly 面板**（`stickerEnabled`、`stickerSize`、`stickerThreshold`、`embeddingDimensions`），并分别写入 `setSaveStatus` 与 `setFireflySaveStatus`。
   - `loadGeneralSettings()`（L793–812）：发起一次 `getGeneral()`，同时回填 **Appearance**（`uiColorControls.load`、`restorePetAndAppearance`）、**Preferences**（`chatSocialContextEnabled`、`restoreChatPreferences`、`channelsGetStatus().then(renderProactiveDeliveryAvailability)`）与 **General**（`toastSoundEnabled`、`launchAtLogin`、`applyLanguageSelection`），并分别写入 `setPreferencesSaveStatus` 与 `setAppearanceSaveStatus`。
2. **渠道状态对偏好面板的跨模块推流**：
   - `loadGeneralSettings()`（L802）与启动段 `window.settings?.onChannelsStatusChanged(...)`（L1407）调用 `channels/panel.ts` 导出的 `renderProactiveDeliveryAvailability`，直接修改 `general/dom.ts` 中 `proactiveDeliverySelect` 下 `.option-block` 的 `disabled`。
3. **API 保存/测试连接与超时面板的耦合**：
   - `testActiveConnection()`（L1005）与 `apiForm` submit（L1242）均先调用 `saveTimeoutSettings(true)`（`timeout/panel.ts`），只有返回 `true` 才继续；而 `apiRuntimeForm` submit（L1131）调用 `saveTimeoutSettings(false)`。
4. **多组复用的界面辅助与交互事件**：
   - `markChoice` / `applyOptionGroupValue` / `getOptionGroupValue` / `onChoice` 被 Appearance（主题/图标）、General（语言）、Preferences（主动聊天/投递目标）、Firefly（表情包尺寸）共同依赖。
   - `subscribeLocaleChanged` 在 `settings.ts` 中分别挂载了两处独立回调：搜索索引刷新（L1384）与 API 预设卡片译文刷新（L1614）。
5. **模块求值期的 DOM 假设与重复事件隐患**：
   - `*/dom.ts` 与 `shared/shell.ts` 在模块顶层执行 `document.getElementById(...)`；`NAV_LABELS`（L214）在模块顶层求值 `t(...)`；L1399 对 `schedulerKindInput` / `schedulerToolLimitInput` 绑定 `updateSchedulerConditionalFields`，而 `scheduler/panel.ts:26` 也在渲染工具复选框时独立绑定了同名回调。
   - `MIMO_ICON_URL`（L82）未在任何地方引用；`fetchModelsBtn` 内直接使用隐式全局标识符 `settings.fetchModels`（L1077）而非 `window.settings!.fetchModels`。
   - `export function applyPreset(...)`（L708）虽然导出，但全仓除 `settings.ts` 内部（L595、614、735、1282）外没有外部调用者。

---

## 2. 拆分边界

### 2.1 边界划分原则

1. **按业务域 + 状态归属 + 数据契约切分**：每个新模块只持有自身面板对应的状态与表单提交逻辑；跨模块通信仅通过函数参数、显式返回值或轻量的只读快照完成，禁止传递覆盖全页面的大共享 `SettingsContext` 可变对象。
2. **集中协调冷启动读，再纯同步回填（Hydration）**：针对 `getConfig()` 与 `getGeneral()` 的跨面板共享特性，保留在入口 `settings.ts` 发起 **各一次** 并行读取，通过各面板导出的 `hydrate*(snapshot)` 同步分发，避免拆成多个独立 IPC 造成冗余往返，也避免在单个面板里直接操作其他面板的 DOM。
3. **新拆出模块一律导出显式 `init*()`，禁止新增顶层副作用执行**：与历史遗留的纯副作用导入（如 `./email/panel`、`./preferences/panel`）不同，本次从 `settings.ts` 抽离的新模块应通过 `init*()` 注册事件监听。入口函数在调用各模块前能明确控制桥接兜底、DOM 就绪和初始数据注入顺序，单测也能只准备局部 DOM 进行独立测试。
4. **已拆分目录遗留逻辑直接归位**：`scheduler`、`memory`、`music` 的零散事件绑定不单开新文件，分别回归到 `scheduler/panel.ts`、`memory/panel.ts` 与 `music/` 中，避免“半拆分”继续残留。

### 2.2 备选方案对比（及不选原因）

| 方案 | 做法 | 不选原因 |
| --- | --- | --- |
| **方案 A（推荐）**：按域拆出 `init*()` + `hydrate*()`，入口集中读取并分发 | API 细分为 4 个高内聚子模块；Appearance/General/ChatPreferences/Firefly 各为独立 `panel`；通用工具与路由归 `shared/`；遗留胶水归位原目录 | **选中**：单文件规模可控（多在 80–280 行），无大共享上下文对象，不增加冷启动 IPC 次数，且兼容现有 `await import("./settings")` 集成测试 |
| **备选 1（不选）**：按行数或上/中/下区域切分为 `settings-part1/2/3.ts`，或构造全局 `ctx` 共享对象 | 按行号把长文件分成 3~4 块，通过同一个 `ctx` 传递 DOM 引用与状态 | 只是物理搬移行号，跨面板状态与耦合原封不动；单元测试依然必须启动整页和全套 mock |
| **备选 2（不选）**：全员改为“纯副作用顶层导入”+ 各面板自行调用 `getConfig()` / `getGeneral()` | 新建 `api/panel.ts`、`appearance/panel.ts` 等均在模块顶层直接监听事件并各自发 IPC | 模块加载即修改 DOM 和触发网络/IPC 请求，测试无法控制执行时序；且 `getGeneral()` 会被重复调用 3 次、`getConfig()` 被调用 2 次，与既有单次调用 mock 断言冲突 |

---

## 3. 拆完后的结构

目录完全遵循 `src/renderer/settings/` 现有子目录约定（`shared/`、`api/`、`appearance/`、`general/`、`preferences/`、`scheduler/`、`memory/`、`music/`）。注：因 `preferences/dom.ts` 与 `preferences/sticker-send-status.ts` 已在 `preferences/` 下管理贴纸控件，本设计将 Firefly 面板放在 `preferences/firefly-panel.ts`，并将对话偏好命名为 `preferences/chat-panel.ts`（避开已有侧重快捷键和贴纸弹窗的 `preferences/panel.ts`）。

### 3.1 新增与调整模块清单

| 目标路径 | 职责说明 | 主要导出签名 | 持有状态 |
| --- | --- | --- | --- |
| `shared/preview-bridge.ts` | 封装浏览器无 Electron 预加载环境下的 `window.settings` / `window.fireflyScheduler` 兜底 mock（并清理死常量 `MIMO_ICON_URL`） | `installPreviewBridge(): void` | 无持久化状态（仅在桥接缺失时初始化全局变量） |
| `shared/option-group.ts` | 统一单选按钮组（`.option-block` / `.seg-option`）状态读写与点击绑定 | `markChoice(button: HTMLElement, active: boolean): void`<br>`selectButtons(container: ParentNode, attr: string, value: string): void`<br>`applyOptionGroupValue(container: HTMLElement, value: string): void`<br>`getOptionGroupValue(container: HTMLElement, fallback: string): string`<br>`onOptionChoice(container: HTMLElement, attr: string, handler: (value: string) => void): void` | 无 |
| `shared/section-router.ts` | 管理左侧导航、`NAV_LABELS` 标题/副标题、面板显隐、`usage`/`subagents` 懒加载、`music` 进入/销毁钩子、hash 与 `onSwitchSection` | `export interface SectionRouter { switchSection(section: string): void; openInitialSection(): void; refreshLabels(): void }`<br>`createSectionRouter(onSectionEntered?: Partial<Record<string, () => void>>): SectionRouter` | 当前已切入 section 与 `NAV_LABELS` 查找表 |
| `appearance/panel.ts` | 统管字体导入/重置/字号、行高/段距、主题/图标、配色控件、`appearanceAdvanced` 与桌面宠物状态 | `initAppearancePanel(): void`<br>`hydrateAppearanceSettings(general: GeneralSettingsPayload): void` | `savedChatAppearance`、`uiColorControls` 句柄、`appearanceAdvanced` 句柄 |
| `general/panel.ts` | 统管界面语言切换、桌面开关（`toastSoundEnabled` / `launchAtLogin` 及失败回滚）、版本号显示 | `initGeneralPanel(): void`<br>`hydrateGeneralSettings(general: GeneralSettingsPayload): void` | 开关各自上一次成功值（闭包局部管理） |
| `preferences/chat-panel.ts` | 统管主动聊天/投递目标选择、分段回复、社交上下文开关与表单提交 | `initChatPreferencesPanel(): void`<br>`hydrateChatPreferences(general: GeneralSettingsPayload): void` | `dirtyPreferences` |
| `preferences/firefly-panel.ts` | 统管表情包开关/尺寸/阈值、`syncStickerSendStatus`、向量维度选择与 `fireflyPanel` 提交 | `initFireflyPanel(): void`<br>`hydrateFireflyConfig(config: ConfigPayload): void` | `dirtyStickers` |
| `api/endpoint-view.ts` | 厂商预设映射、图标/官网展示、Endpoint 预览、`applyPreset`、协议切换（`changeTransport`）与 Work-Flow 兼容弹窗 | `fillPresetOptions(): void`<br>`findPreset(providerName: string): ModelPreset \| undefined`<br>`setActivePresetCard(providerName: string): void`<br>`getCurrentModelValue(): string`<br>`getApiKeyForRequest(): string`<br>`validateActiveCustomEndpoint(): string \| null`<br>`updateEndpointPreview(): void`<br>`applyCustomEndpointUI(): void`<br>`changeTransport(transport: string): void`<br>`applyPreset(providerName: string, savedModel?: string, savedKey?: string, savedBaseUrl?: string, savedDisplayName?: string, savedTransport?: ApiTransport): void`<br>`bindWorkFlowAdaptModal(): void` | 无（读写 DOM 与 `./state.ts` 的 `apiState`） |
| `api/fetch-models-controller.ts` | 管理 `modelPicker`、`inputModalities` 与动态拉取模型请求防并发错序（显式使用 `window.settings!.fetchModels`） | `initFetchModelsController(hooks: { onDraftMutated: () => void }): FetchModelsController`<br>`export interface FetchModelsController { resetForEdit(): void; closePicker(): void; syncModelSuggestion(model: string): void; clearFetchedModalities(): void; getFetchedModalities(modelId: string): readonly InputModality[] \| undefined }` | `fetchModelsGeneration`、`fetchedInputModalities`、`modelPicker`、`inputModalities` 实例 |
| `api/profile-draft.ts` | 档案列表渲染、编辑/新建切换、未保存草稿比对、丢弃确认提示、删除与关闭档案编辑 | `initProfileDraftController(deps: { fetchModels: FetchModelsController; onProfileLoaded: () => void }): ProfileDraftController`<br>`export interface ProfileDraftController { updateDraftState(): void; reloadProfiles(preferredId?: string): Promise<void>; editProfile(id: string): void; startNewDraft(providerName: string): void; changeEditor(guardMessage: string, apply: () => void): Promise<void>; isCurrentProfilePanel(): boolean; isSavePending(): boolean; setSavePending(pending: boolean): void }` | 原顶层草稿状态：`profileDraftBaseline`、`profileTransitionPending`、`profileSavePending`、`profileEditorReturnProfileId`、`profilePendingButtons`（或收归 `./state.ts` 集中维护） |
| `api/panel.ts` | 组装 API 主表单与运行时超时表单：`loadConfig` 回填全局参数、测试连接（含 `saveTimeoutSettings(true)`）、`apiForm`/`apiRuntimeForm` 提交、卡片与 tab 选择、locale 变更重译 | `initApiPanel(): ApiPanelHandle`<br>`hydrateApiConfig(config: ConfigPayload, profilesData: ProfileCatalog): Promise<void>`<br>`export interface ApiPanelHandle { translateProviderUi(): void }` | 协调 `ProfileDraftController` 与 `FetchModelsController` 句柄 |
| `scheduler/panel.ts` *(既有文件扩展)* | 吸收 `settings.ts:1392-1400` 的新增/取消按钮事件与条件字段初始化，统一收口在面板内部 | 在既有导出外增加：`initSchedulerPanel(): void`（包含 `schedulerClicks` 及条件字段变化监听） | 沿用 `scheduler/state.ts` |
| `memory/panel.ts` *(既有文件扩展)* | 吸收 `settings.ts:1417-1440` 的已导入文档删除事件委托 `removeImportedDocument` | 在既有导出外增加：`initMemoryPanel(): void`（挂载 `memoryImportedList` 点击委托） | 沿用 `memory/panel.ts` 现有状态 |
| `music/panel.ts` *(新建轻入口)* | 吸收 `settings.ts:1442-1445` 的 QQ 音乐跳转按钮绑定，并与 `qqmusic-panel.ts` 并存 | `initMusicShortcut(navigateToMusic: () => void): void` | 无 |

### 3.2 拆分后 `settings.ts` 保留内容（预计约 90–120 行）

瘦身后的 `settings.ts` 仅作为总装入口：
1. 导入既有纯副作用面板（`./email/panel`、`./search/panel`、`./user/panel`、`./plugins/panel`、`./plugins/permission`、`./rag/panel`、`./preferences/panel`、`./mcp/panel`）与新拆出的各域 `panel.ts` / `shared/` 模块。
2. 调用 `installPreviewBridge()`，保证全局桥接兜底先于任何读请求就位。
3. 绑定窗口标题栏按钮（`minBtn`、`closeBtn`）。
4. 初始化各域面板监听：`initGeneralPanel()`、`initAppearancePanel()`、`initChatPreferencesPanel()`、`initFireflyPanel()`、const `apiPanel = initApiPanel()`、`initSchedulerPanel()`、`initMemoryPanel()`，以及 `bindDesktopAsrSettings(document, window.settings)` 与 `mountPluginPanels()`。
5. 定义协调型加载函数 `loadConfig()` 与 `loadGeneralSettings()`：各自只发一次 `getConfig()`+`getModelProfiles()` 或 `getGeneral()`，随后同步调用对应域的 `hydrate*()`，并配合 `channelsGetStatus()` + `onChannelsStatusChanged` 更新主动投递可用性。
6. 创建并启动 `sectionRouter = createSectionRouter(...)` 与 `initMusicShortcut(() => sectionRouter.switchSection("music"))`、`mountSettingsSearch(...)`、`subscribeLocaleChanged(...)`。
7. 运行全局 UI 增强（`attachDatePicker`、`enhanceSelects`、`trackRangeFills`），发起启动加载与 `openInitialSection()`。

---

## 4. 状态与副作用

### 4.1 状态归属矩阵

| 状态名称 | 当前位置 | 拆分后归属 | 说明 |
| --- | --- | --- | --- |
| `apiState` | `api/state.ts` | `api/state.ts`（不变） | 由 `api/profile-draft.ts`、`api/endpoint-view.ts`、`api/panel.ts` 按职责读写 |
| `profileDraftBaseline`、`profileTransitionPending`、`profileSavePending`、`profileEditorReturnProfileId`、`profilePendingButtons` | `settings.ts:467-471` | `api/profile-draft.ts`（闭包私有，通过控制器接口暴露必要查询） | 外部不再直接改动布尔标志，防止状态与 UI 脱节 |
| `fetchedInputModalities`、`fetchModelsGeneration`、`modelPicker`、`inputModalities` | `settings.ts:424-433, 1039` | `api/fetch-models-controller.ts` | 拉取竞争保护完全内聚在控制器内部 |
| `savedChatAppearance`、`uiColorControls`、`appearanceAdvanced` | `settings.ts:236, 314-315` | `appearance/panel.ts` | 仅在外观保存与回填时读写 |
| `dirtyPreferences` / `dirtyStickers` | `settings.ts:827-828` | `preferences/chat-panel.ts` / `preferences/firefly-panel.ts` | 各自维护未保存提示文案 |
| `preferencesState` | `preferences/state.ts` | `preferences/state.ts`（不变） | 仍服务于 `preferences/panel.ts` 贴纸弹窗 |

### 4.2 副作用清单

- **读写设置与配置**：
  - `appearance/panel.ts`：`saveGeneral`、`pickUiFont`、`importUiFont`、`resetUiFont`、`setPetAlwaysOnTop`、`setPetVisible`、`setPetZoom`。
  - `general/panel.ts`：`saveGeneral`、`appUpdate.getState()`。
  - `preferences/chat-panel.ts`：`saveGeneral`、`channelsGetStatus`。
  - `preferences/firefly-panel.ts`：`saveConfig`。
  - `api/panel.ts` & 子模块：`saveConfig`、`saveModelProfile`、`deleteModelProfile`、`testConnection`、`fetchModels`，以及经 `timeout/panel.ts` 调用的 `saveTimeoutSettings`。
  - `settings.ts` 协调层：`getConfig`、`getModelProfiles`、`getGeneral`、`channelsGetStatus`。
- **IPC 事件监听**：
  - `onSwitchSection` 迁入 `shared/section-router.ts`。
  - `onChannelsStatusChanged` 留在 `settings.ts`（或由 `preferences/chat-panel.ts` 注册并依赖 `renderProactiveDeliveryAvailability`）。
- **DOM 副作用**：
  - 所有既有 `*/dom.ts` 与 `shared/shell.ts` 在导入时执行 `document.getElementById`，该既有约定保持不变（PR 内不扩大重构面）。
  - `enhanceSelects(document.body)`、`trackRangeFills(document.body)`、`attachDatePicker(userBirthdayInput)` 保留在入口初始化尾部；`location.hash` 读取与 `window.scrollTo` / `.settings-content.scrollTop = 0` 迁入 `shared/section-router.ts`。

### 4.3 初始化与监听注册顺序约束（硬约束）

1. **`installPreviewBridge()` 必须最先执行**：保证在 Electron 之外的预览模式或简化测试环境下，`window.settings` 与 `window.fireflyScheduler` 在任何面板绑定前就绪。
2. **`inputModalities` / `uiColorControls` / `appearanceAdvanced` 等子控制器创建早于 `hydrate*()`**：否则首次回填配置时会漏同步子控件 UI，或因监听先于赋值触发错误的脏状态检查。
3. **预设列表先填充，再执行 `enhanceSelects(document.body)`**：`fillPresetOptions()` 与模型/字体初始 `<select>` 构造必须在 `enhanceSelects` 包装原生选择框前完成，避免自定义下拉缺少选项。
4. **面板监听器全部注册完再触发 `loadConfig()` / `loadGeneralSettings()` 与 `openInitialSection()`**：避免用户在慢机器上极快触发事件或 `onSwitchSection` 先到达而命中未初始化表单。
5. **Hydration 容错隔离**：`loadConfig()` 分发给 `hydrateApiConfig` 与 `hydrateFireflyConfig`、`loadGeneralSettings()` 分发给 `hydrateAppearanceSettings` / `hydrateGeneralSettings` / `hydrateChatPreferences` 时，不得因一个子域缺少某可选字段而阻断同批次其余子域的状态回填。

---

## 5. 测试保护

### 5.1 已有测试与覆盖盘点

通过当前目录扫描与执行确认，`src/renderer/settings/` 共有 **64 个测试文件、587 条测试**（全部在基线通过）。其中与 `settings.ts` 强相关的测试包括：

1. **直接导入 `./settings` 的全页集成测试**：
   - `src/renderer/settings/provider-settings.integration.test.ts`：覆盖 API 档案增删改查、草稿未保存切换/关闭拦截、供应商 tab 切换、自定义云/本地端点切换、输入模态、拉取模型弹窗、General 语言切换与桌面开关回滚、插件文件权限槽位。
   - `src/renderer/settings/custom-endpoint-markup.test.ts`：覆盖同厂商多档案编辑、协议与自定义云/本地端点切换。
2. **硬编码读取 `"settings.ts"` 源码字符串的高敏感回归测试**：
   - `src/renderer/settings/api/fetch-models-i18n.test.ts`：直接 `readFileSync("settings.ts")`，断言文件中至少匹配 8 个 `t("settings.panel.api.field.model.fetch.*")` 键。**搬移拉取模型逻辑时必须同步更新此测试的目标文件列表。**
   - `src/renderer/settings/default-dialogs-regression.test.ts`：扫描 `settings.ts` 确保无原生 `alert` / `confirm` / `showModal`。**拆出的新 `panel.ts` 应加入扫描列表。**
   - `src/main/character-migration.test.ts`（第 99 行）：正则检查 `"src/renderer/settings/settings.ts"` 不含已迁移的旧角色资源路径。**拆出后需覆盖新增文件路径或保持入口覆盖。**
3. **局部单元/静态契约测试**：
   - `settings-navigation.test.ts`、`appearance-settings-markup.test.ts`、`advanced-settings-markup.test.ts`、`settings-i18n-regression.test.ts`、`custom-endpoint-state.test.ts`、`optional-panel-controls.test.ts`、`desktop-asr-settings.test.ts`、`preferences/sticker-send-status.test.ts`、`appearance/colors.test.ts`、`appearance/advanced.test.ts`、`api/*`、`scheduler/panel.test.ts`、`memory/panel.test.ts`、`timeout/panel.test.ts`。

### 5.2 拆前必补测试（遵循 `AGENTS.md` 测试断言规范）

在搬动任何代码前，必须在独立测试文件或对应既有测试中补齐当前 `settings.ts` **未被集成测试覆盖**的 7 组真实行为测试（严格遵循完整断言、不写“不报错即通过”、不以快照代替行为、明确负向副作用检查）：

| 编号 | 覆盖行为 | 对应 `AGENTS.md` 断言规则与具体写法 |
| --- | --- | --- |
| **T1** | **外观设置保存、字号/行高提交与取消字体选择保护** | 规则 1、2、6（完整字段对比 + 负向副作用）：修改字体字号与行高滑块、点击“导入字体”并模拟 `importUiFont()` 返回 `{ ok: false, canceled: true }`，断言不触发 `saveGeneral`；再切换主题 `uiTheme` 与图标 `uiIcon`，断言 `saveGeneral` 收到的完整 patch 对象等于 `{ uiTheme: "...", uiIcon: "..." }` 且提示状态变为成功；若 `saveGeneral` reject，断言状态显示失败文案且不伪造成功态 |
| **T2** | **聊天偏好提交与 `channelsStatusChanged` 联动** | 规则 1、2、4（真事件状态驱动 + 完整对象）：勾选/取消 `segmentedChatEnabled` 与 `chatSocialContextEnabled`、切换 `proactiveChatMode` 与 `proactiveDeliveryTarget` 后提交 `preferencesForm`，断言 `saveGeneral` 收到完整 `{ proactiveChatMode, proactiveDeliveryTarget, segmentedChatEnabled, chatSocialContextEnabled }`；触发 `onChannelsStatusChanged({ qq: { phase: "offline" }, wechat: { phase: "running" } })`，逐项断言 `proactiveDeliverySelect` 中 `qq` 按钮 `disabled === true`、`wechat` 与 `local` 按钮 `disabled === false` |
| **T3** | **Firefly 贴纸与向量维度保存** | 规则 1、2、6：关闭 `stickerEnabled`、改选 `stickerSize`、调整 `stickerThreshold` 与 `embeddingDimensions` 后提交 `fireflyPanel`，断言 `saveConfig` 收到完整期望配置对象，且 `syncStickerSendStatus` 文本与 `dataset.i18n` 与开关状态一致；若 `saveConfig` 返回错误或未点击提交，断言既有配置字段不被隐式写入 |
| **T4** | **`testActiveConnection` 先存超时再测连与本地兜底 Key** | 规则 1、2、6（调用顺序与负载 + 负向中断）：先设非法 `timeoutTestInput`（如 `"0"`），触发测试连接，断言 `saveTimeoutSettings` 拦截并**未调用** `window.settings.testConnection`；随后改回合法超时并在自定义本地端点空 key 下点击测试，断言先完成 `saveTimeoutSettings(true)` 再调用 `testConnection` 且入参包含局部兜底 key 与完整 endpoint/transport/model 字段 |
| **T5** | **`fetchModels` 并发请求防乱序与错误文案映射** | 规则 1、5、12（稳定条件/错误分支映射 + 并发竞态）：用可手动 resolve 的双 Promise 模拟连续两次点击 `fetchModelsBtn`，先让第 2 次响应返回新模型列表，再让第 1 次过期响应返回旧列表，断言 `modelPicker` 候选列表仅包含第 2 次结果且旧响应未回写 DOM；再模拟 `{ ok: false, error: "HTTP 401" }` 等错误响应，断言显示对应的真实错误提示而非通用兜底 |
| **T6** | **Section 路由、Hash 初始定位、IPC 切换与懒加载** | 规则 1、6、9：以 `location.hash = "#channels"` 启动页面，断言 `channels` 面板可见、对应导航 `aria-current="page"`、顶部标题/提示与 `loadChannelsPanel` 生效；随后切换到 `music` 再切至 `unknown-section`（回落 `general`），断言离开 `music` 时触发卸载逻辑且进入未知分类时不会向 `music` 或 `usage` 发多余请求 |
| **T7** | **遗留胶水：Memory 导入文档删除确认与 Scheduler 条件字段** | 规则 1、2、6（二次确认取消不触发删除）：模拟点击 `memoryImportedList` 删除按钮并在确认弹窗点击“取消”，断言 `window.memoryPanel.deleteImportedDoc` **未被调用**（`toHaveBeenCalledTimes(0)`）；改为“确认”后，断言以精确 `docId` 调用一次并刷新列表；切换 `schedulerKindInput` / `schedulerToolLimitInput` 断言对应条件区隐藏/展示类名精准切换 |

---

## 6. 实施批次与提交顺序

拆分必须严格坚持 **先测试后搬移、小步提交、纯重构与 bug 修复分离**。每一提交单独检出均须通过 `npm run check:renderer` 与设置页 Vitest 测试。

### PR 划分与 Commit 序列（共 4 个 PR）

| PR | 主题 | Commit 顺序与说明 | 是否含行为变化 |
| --- | --- | --- | --- |
| **PR 1** | 补齐拆前回归保护网 | **C1**：新增拆前行为测试覆盖 T1–T3（外观、偏好联动、Firefly 保存）<br>**C2**：新增拆前行为测试覆盖 T4–T7（测试连接、拉取模型防乱序、路由/hash/IPC、Memory/Scheduler 遗留绑定） | 纯补测试，不改业务代码 |
| **PR 2** | 清理壳层工具、兜底桥接与孤儿胶水 | **C3**：抽出 `shared/preview-bridge.ts` 并移除死常量 `MIMO_ICON_URL`（独立清理、不改业务行为）<br>**C4**：抽出 `shared/option-group.ts` 替代 `settings.ts` 内 `markChoice`/`onChoice` 等<br>**C5**：抽出 `shared/section-router.ts` 接管导航路由、标题提示与懒加载<br>**C6**：将 `scheduler`、`memory`、`music` 遗留绑定归位到各自目录的 `init*`（**注**：去重 `scheduler/panel.ts:26` 重复监听若改变执行次数，单独在后续 bugfix commit 处理，不混在 C6 搬移中）<br>**C7**：把 `default-dialogs-regression.test.ts` 与 `character-migration.test.ts` 的 owner 列表扩至新文件 | 纯结构整理（死常量清理零行为变化） |
| **PR 3** | 拆出 General / Chat Preferences / Firefly / Appearance 面板 | **C8**：拆出 `general/panel.ts`（语言切换、桌面开关与版本展示）<br>**C9**：拆出 `preferences/chat-panel.ts` 与 `preferences/firefly-panel.ts`（贴纸表单 + 主动投递/社交上下文表单）<br>**C10**：拆出 `appearance/panel.ts`（颜色、字号/行高、主题/图标、字体管理、宠物控件），入口保持 `loadGeneralSettings()` 与 `loadConfig()` 单次 IPC 分发给各域 `hydrate*()` | 纯重构，IPC 调用次数保持不变 |
| **PR 4** | 拆解 API 大模块并收敛 `settings.ts` 入口 | **C11**：拆出 `api/endpoint-view.ts`（Presets、Custom Endpoint、`applyPreset`、`changeTransport`、Work-Flow 弹窗）<br>**C12**：拆出 `api/fetch-models-controller.ts`（同步更新 `api/fetch-models-i18n.test.ts` 的源文件读取目标，并把隐式 `settings.fetchModels` 明确改为 `window.settings!.fetchModels`）<br>**C13**：拆出 `api/profile-draft.ts`（档案草稿比较、切换守卫、列表与删除确认）<br>**C14**：拆出 `api/panel.ts`，并将 `settings.ts` 收敛为约 100 行的纯粹总装与冷启动分发入口 | C11–C14 纯重构；若后续单独改进“语言切换时同步更新 `NAV_LABELS`”等既有问题，另立独立 fix commit |

---

## 7. 风险与回退

### 7.1 核心风险与规避措施

1. **硬编码扫描 `"settings.ts"` 的源码级测试立即失败**：
   - *风险点*：`api/fetch-models-i18n.test.ts` 直接读取 `settings.ts` 并正则要求存在 `>= 8` 个 fetch 文案 key；`default-dialogs-regression.test.ts` 与 `src/main/character-migration.test.ts` 也按文件名白名单扫描 `settings.ts`。
   - *规避*：在 C7 与 C12 的**同一提交**内同步扩展或改写对应测试文件的读取路径，使 CI 与本地单一 commit 检查始终全绿。
2. **模块顶层 `document.getElementById` 对导入与 DOM 时序敏感**：
   - *风险点*：`*/dom.ts` 与 `shared/shell.ts` 在模块求值阶段即查询 DOM。若新面板把 DOM 查询写在模块顶层，在只搭部分 HTML 的测试或按需加载场景下会变成 `null` 崩溃。
   - *规避*：新提取文件只复用既有的 `*/dom.ts` 或在 `init*()` 内部按需查询 DOM；不新增模块顶层 `document.getElementById` 调用。
3. **`enhanceSelects(document.body)` 与下拉动态内容先后顺序颠倒**：
   - *风险点*：如果入口过早执行 `enhanceSelects`，而 `api/panel.ts` 尚在初始化 `fillPresetOptions()` 等下拉选项，自定义 select 包装可能丢失选项或不同步。
   - *规避*：保持 `enhanceSelects(document.body)`、`trackRangeFills` 位于各域 `init*()` 完成后、冷启动异步回填发起前的原位置，不提前调用。
4. **`loadGeneralSettings()` / `loadConfig()` 单次扇出异常传播**：
   - *风险点*：拆出多个 `hydrate*()` 后，如果某一域回填抛出异常，可能中断同一 `try` 块中后续域的初始化或状态重置。
   - *规避*：入口处对各 `hydrate*()` 做独立错误边界包装或确保 `hydrate*()` 仅执行安全赋值。
5. **非静态/内部导出符号遗漏**：
   - *风险点*：`applyPreset` 当前带 `export`，全仓虽仅有 `settings.ts` 内部调用，但外部 PR 若正在同步合入新引用可能找不到符号。
   - *规避*：拆到 `api/endpoint-view.ts` 后，如有平行 PR 依赖可暂在 `settings.ts` 保留一行 `export { applyPreset } from "./api/endpoint-view"` 过渡，确认无外部引用后再删。

### 7.2 回退策略

- 因每个 PR 与每条 commit 只移动单一边界、不夹带业务/UI 改版，若某项拆分在真机联调出现异常，可直接在目标分支对单个 commit 执行 `git revert <sha>`（或整个 PR 级回退）立即恢复至 `settings.ts` 原位，零数据格式或跨进程契约迁移成本。

---

## 8. 验证方法

### 8.1 自动化命令（全部来自 `package.json` 真实脚本）

每次提交后在仓库根目录（Windows PowerShell 需显式关闭实验性 `webstorage` 以适配 jsdom）依次执行：

1. **渲染进程类型检查**：
   - `npm run check:renderer`（执行 `tsc -p tsconfig.renderer.json`）
2. **设置页 Vitest 定向回归**：
   - `$env:NODE_OPTIONS='--no-experimental-webstorage'; npx vitest run src/renderer/settings`
3. **存储边界与渲染构建验证（PR 合并前必跑）**：
   - `npm run check:storage-boundary`（执行 `node scripts/verify/storage-boundary.mjs`）
   - `npm run build:renderer`（执行 `vite build`，验证 `<script src="./settings.ts">` 及动态 chunk `./usage/panel`、`./api/agent-routing` 打包无循环依赖或缺失）
4. **全量测试套件（每个 PR 合入前跑一次）**：
   - `$env:NODE_OPTIONS='--no-experimental-webstorage'; npm test`（执行 `node scripts/testing/run-tests.mjs`）

### 8.2 Electron 真机交互检查项（每个相关 PR 合入前手测）

1. **壳层与导航（PR 2）**：最小化/关闭窗口按钮生效；点击全部左侧导航及使用上下箭头、`Home`/`End` 键切换分类，右侧内容区滚顶且标题与提示文案匹配；搜索设置项能跳转并高亮目标行；点击 QQ 音乐入口正确进入 `music` 面板，切出后停止轮询；测试 Scheduler 定时任务按钮与 Memory 导入文档删除弹窗确认/取消。
2. **外观与通用（PR 3）**：中英文语言切换立即生效且刷新状态；打开/关闭桌面提示音与开机自启；调整字号、行高、段距滑块、配色控件、选择/导入/重置字体、切换主题与图标，重启设置页后全部保持还原；切换 `proactiveDelivery` 在渠道停用时禁用对应按钮；保存 Firefly 贴纸参数与向量维度后持久化。
3. **API 与超时（PR 4）**：新增、编辑、复制保护（修改后切 tab / 点关闭触发丢弃确认）、删除模型档案；点击“获取模型列表”可搜可选并自动同步输入模态；点击“测试连接”可正确带上超时校验并展示结果；打开 Work-Flow 适配指南弹窗可查看与关闭；重启设置窗口默认回显当前激活档案。

## 负责人决定（hotaru，2026-11-15）

1. 新拆出的面板统一导出 `init*()` / `hydrate*()`，由入口按顺序调用；已经拆出去的面板保持不动。
2. Firefly 面板放在 `preferences/firefly-panel.ts`，和现有的 `preferences/dom.ts`、`preferences/sticker-send-status.ts` 放在一起。
3. API 部分按本文第 3 节拆成 4 个文件：`api/endpoint-view.ts`、`api/fetch-models-controller.ts`、`api/profile-draft.ts`、`api/panel.ts`。
4. 顺带发现的小问题，等拆分完成后单独提一个修复 PR，不混进搬移提交：
   - `NAV_LABELS` 只在模块加载时求值一次，切换语言后导航标题不刷新；
   - `MIMO_ICON_URL` 没有引用；
   - `fetchModelsBtn` 里直接用了全局标识符 `settings.fetchModels`。

   因此 C12 搬移时保留原写法 `settings.fetchModels`，改成 `window.settings!.fetchModels` 留到这个修复 PR；C3 也不删除 `MIMO_ICON_URL`，删除放进同一个修复 PR。
