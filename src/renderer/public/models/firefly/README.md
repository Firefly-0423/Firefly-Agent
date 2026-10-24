# Firefly Live2D Model Directory (流萤 Live2D 模型资源目录)

This directory is designated for the Live2D Cubism 3/4 runtime model files.

## Third-Party Asset Notice (第三方资产说明)
The Live2D model assets are third-party character assets. This checkout tracks the model manifest, model binary, texture, physics, expressions and motions; their presence does not establish redistribution rights. Preserve the source and authorization records in [THIRD_PARTY_NOTICES.md](../../../../../THIRD_PARTY_NOTICES.md) and [MODEL_LICENSE.md](../../../../../MODEL_LICENSE.md). Only the permissions applicable to these assets establish their distribution scope.

## Resource Installation (模型安装指引)
To enable full Live2D rendering in local development:
1. Place the model bundle files into this directory (`src/renderer/public/models/firefly/`), preserving the exact paths in `Firefly.model3.json`:
   - `Firefly.model3.json` (Main model configuration)
   - `Moc_0.moc3` (Live2D Cubism model binary)
   - `Textures_0_0.png` (Texture atlas)
   - `Physics_0.json` (Physics calculation definitions)
   - `Expressions/` (Expression files referenced by `FileReferences.Expressions`)
   - `Motions/` (Motion files referenced by `FileReferences.Motions`)
2. Firefly loads `models/firefly/Firefly.model3.json` through the renderer asset resolver; valid model resources enable Live2D rendering with eye focus and mouth synchronization.
3. If model files are absent, the application reports Live2D unavailable (no PNG animation fallback).
