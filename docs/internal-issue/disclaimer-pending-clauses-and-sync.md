# 免责声明占位条款待定及第 ⑤ 条数据目录描述滞后

状态：待负责人决定
日期：2026-11-16

## 现象

三语免责声明（`docs/disclaimer.zh-CN.md`、`docs/disclaimer.en.md`、`docs/disclaimer.ja-JP.md`）存在以下两类待处理内容：

1. **占位与草案待定**：
   - 第 ⑪ 条「权利争议与处理」中私密联系渠道仍为占位符 `【待负责人填写：私密联系渠道】`，且处理时限标注“处理时限待负责人提供”。
   - 第 ⑧ 条「未成年人使用条件（草稿）」及文首元数据标注“未成年人条款为草稿，待负责人审核措辞”“最终措辞待 hotaru 审核”。
2. **第 ⑤ 条正式数据目录正文与代码现状不一致**：
   - `docs/disclaimer.zh-CN.md`（及对应译文）第 ⑤ 条仍写“当前正式目录由代码解析为 `%APPDATA%\Firefly`，1.2.0 计划采用 `%APPDATA%\Firefly-1.2.0`，切换仍待启动隔离施工落实”。
   - 而 PR `#62`（`ecdd9d8`，`feat/data-dir`）已将 `src/main/base/identity/data-directory.ts` 中的 `FIREFLY_DATA_DIRECTORY` 正式改为 `"Firefly-1.2.0"`，并在 `build/installer.nsh` 与 `README.md` 落地生效。

## 触发条件或复现步骤

1. 审阅 `docs/disclaimer.zh-CN.md` 元信息行、第 ⑤ 条、第 ⑧ 条与第 ⑪ 条。
2. 对照 `src/main/base/identity/data-directory.ts` 与 `docs/superpowers/plans/2026-11-13-data-directory-1-2-0-progress.md`。

## 影响范围

- **受影响文档**：`docs/disclaimer.zh-CN.md`、`docs/disclaimer.en.md`、`docs/disclaimer.ja-JP.md`（以及打包附带离线副本流程）。
- **用户体验影响**：正式渠道与处理时限未填导致权利人缺少非公开提交路径；第 ⑤ 条表述与 1.2.0 当前实际数据目录 `%APPDATA%\Firefly-1.2.0` 不一致。

## 根因

1. 第 ⑧ 条与第 ⑪ 条涉及项目负责人的合规与联系政策拍板，按 `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md`（未完成项与验收待办）特意留给维护者 `hotaru` 审核填写。
2. PR `#63`（`feat/docs-eng`）基于旧基线 `74d4d4e` 施工时，PR `#62`（`feat/data-dir`）尚未合入，当时按 `docs-and-engineering-progress.md` 全局约束不能提前宣称目录已切换；两分支先后合入后形成了文档文本相对 PR `#62` 代码的短暂滞后。

## 当前状态

- **待负责人决定**：由 `hotaru` 审核定稿第 ⑧ 条未成年人条款措辞、填写第 ⑪ 条私密联系渠道及处理时限，并确认同步更新三语免责声明第 ⑤ 条关于 `%APPDATA%\Firefly-1.2.0` 已落地的描述。

## 相关文件

- `docs/disclaimer.zh-CN.md`
- `docs/disclaimer.en.md`
- `docs/disclaimer.ja-JP.md`
- `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md`
- `docs/superpowers/plans/2026-11-13-data-directory-1-2-0-progress.md`
- `src/main/base/identity/data-directory.ts`
- 相关 PR：PR `#62`（`ecdd9d8`）、PR `#63`（`d2d1184`）
