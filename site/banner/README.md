# Site banners

The README banners (`readme-assets/firefly-banner-*.gif`) with the title changed to "Firefly-Agent" for the site.

- `banner-*.svg`: copies of `readme-assets/sources/banner-*.svg` with that one text change.
- `firefly-banner-*.gif`: each README banner with the right-hand panel (x ≥ 560 at 1792×468) replaced by the matching SVG rendered at 1792×468 in Chromium. The Live2D animation on the left and the frame timing are unchanged. The panel is identical in every frame of the source GIFs, so one image covers all 155 frames.

Encoded with ffmpeg (`palettegen=stats_mode=diff`, `paletteuse=diff_mode=rectangle`).
