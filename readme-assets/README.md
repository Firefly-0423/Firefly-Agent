# README 展示素材

README 使用 GitHub 原生 `picture` / `prefers-color-scheme` 切换明暗素材，并以浅色图片回退。正文、链接、表格及页面背景跟随 GitHub 宿主主题。

- `firefly-banner-{light,dark}[.en].gif`：中英文完整动画，1792 × 468 像素，README 按 896 × 234 显示。155 帧，每帧 80 ms，12.4 秒无限循环。
- 技术与平台徽章不再保存为文件，直接引用 Shields.io 静态徽章，见 [ICON_SOURCES.md](./ICON_SOURCES.md)。
- `screenshots-pending-{light,dark}[.en].svg`：明确标为待补的真实界面展示位置，不是产品截图。
- `sources/`：横幅背景 SVG、原生表情时间表与模型来源校验。

## 原模型动画

动画直接从仓库的 `src/renderer/public/models/firefly/`、Cubism Core 与现有 Pixi Live2D 运行库透明渲染。运行原生 Idle/0、表情与 physics；角色比例、贴图、网格与模型文件不变，没有使用生成式模型重画，也没有从旧 GIF 抠出角色。

保留待机与眨眼、猫耳、墨镜、问号、闭眼表情的顺序。猫耳 Param40 可见窗口为第 29–74 帧，约 2.32–5.92 秒；循环末尾淡回默认表情。文案和背景使用批准的双主题版式，文字区域在整个循环中保持稳定。

文档录制器使用固定位置和比例，隐藏 ArtMesh153–157 场景网格，分别在浅灰绿与深墨绿背景上合成透明边缘。此设置只用于展示素材，不改变桌宠行为。保留原动作中的呼吸，关闭另一套独立呼吸振荡，以避免无关周期带来的接缝。

## 重新生成

需要项目现有 Node.js 依赖、Playwright 可用的 Chromium，以及带 Pillow 的 Python。已核对的渲染库为 PixiJS 7.4.3、pixi-live2d-display 0.5.0-beta；这些脚本不启动 Electron 产品或执行产品构建。

在仓库根目录执行，录制目录使用仓库外的独立临时目录：

```sh
node scripts/docs/render-readme-banner.mjs --out ../firefly-readme-recording
node scripts/docs/render-readme-backgrounds.mjs --repo . --out ../firefly-readme-recording
python scripts/docs/encode-readme-banner.py --repo . --out ../firefly-readme-recording
```

两份 Node 脚本均可通过 `--edge` 指定已安装的 Chromium 系浏览器可执行文件；`--deps` 可指定拥有相同项目依赖的目录。模型与 Cubism Core 始终从 `--repo` 指定的仓库读取。原始透明帧和核验 JSON 只输出到录制目录，四套 GIF 写入 `readme-assets/`。

编码器检查完整循环时长、恒定文字、角色透明边缘、五个场景网格隐藏、表情回归、固定几何变换及单文件体积。图像采用固定共享调色板，分别保留文字/背景与角色颜色；没有为消除接缝复制替换角色的首尾帧。字体、浏览器与图像库版本变化可能影响重生成字节，应重新进行视觉与循环核查。

## 依据与素材许可

- [GitHub 图片主题切换与 details](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/quickstart-for-writing-on-github#adding-an-image-to-suit-your-visitors)
- [Shields 静态徽章参数](https://shields.io/badges/static-badge)
- [Pixi Live2D 手动更新模型](https://guansss.github.io/pixi-live2d-display/models/#updating-manually)
- [PixiJS 7 Application](https://pixijs.download/v7.3.0/docs/PIXI.Application.html)

徽章来源和许可见 [ICON_SOURCES.md](./ICON_SOURCES.md)。技术徽章只说明技术栈，不表示 CI、排名、发布状态或官方关联。角色及派生渲染的授权边界见 [MODEL_LICENSE.md](../MODEL_LICENSE.md) 和 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
