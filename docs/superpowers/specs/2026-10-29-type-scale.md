# One type scale, bundled fonts

Status: approved by the owner 2026-10-29 (bundle the fonts, add the guard test). Branch feat/type-scale, on top of feat/composer-effort-skin (PR #7), because both touch the same stylesheets.

## Problem

Measured on the renderer CSS (`src/renderer/**/*.css`):

- 22 different pixel font sizes. The ones under 12px are 10px (14 uses), 10.5px (4), 11px (53) and 11.5px (25). Around the middle there are 12px (198), 12.5px (45), 13px (150), 13.5px (14), 14px (47) and 14.5px (2). Neighbouring steps half a pixel apart do not read as a hierarchy, and the 10–11.5px text is what makes panels such as the effort panel feel too small.
- Sans: almost every rule uses `var(--rb-font-sans)` (Noto Sans SC first). Two files set their own stacks: CodeGitPanel (`-apple-system, … "Microsoft YaHei"`) and the weather card (`--font-main`).
- Mono: two families mixed. Code blocks, diff and Git chips use Consolas/Cascadia; settings and the slash menu use `var(--rb-font-mono)` (JetBrains Mono first) or one of several other ad-hoc stacks.
- `src/renderer/ui/fonts.css` loads Noto Sans SC and JetBrains Mono from Google Fonts at runtime. Offline, or where Google is unreachable, the app silently falls back to Microsoft YaHei/Consolas and looks different. It also sends a request to a third party on every launch.

## Decision asked of the owner

1. **Bundle the fonts** (recommended). Add `@fontsource-variable/noto-sans-sc@5.3.1` (OFL-1.1, 4.9 MB unpacked, split by unicode range so a page loads only the chunks it uses) and `@fontsource-variable/jetbrains-mono@5.3.0` (OFL-1.1, 0.2 MB) as dependencies. `fonts.css` imports them instead of Google Fonts. The OFL notices go into the third-party license list. Installer grows by about 5 MB.
   - Alternative: drop the web fonts and use the system stack (Microsoft YaHei UI on Windows). Zero size, but the look changes from today's Noto Sans SC and differs per OS.
2. **A guard test** (optional; asked because it is a new check): a vitest that fails when a stylesheet uses a font size outside the scale, so the scale stays one scale. Without it the scale is held by review only.

## The scale

Tokens in `src/renderer/ui/tokens.css`, used through `font-size: var(--ff-fs-…)`:

| Token | Size | Use | Replaces |
| --- | ---: | --- | --- |
| `--ff-fs-caption` | 12px | counts, timestamps, hints, tick labels | 10, 10.5, 11, 11.5, 12 |
| `--ff-fs-ui` | 13px | controls, lists, secondary text, panel rows | 12.5, 13, 13.5 |
| `--ff-fs-body` | 14px | UI body text, inputs | 14, 14.5 |
| `--ff-fs-title` | 16px | panel and dialog titles | 15, 16 |
| `--ff-fs-heading` | 18px | section headings, the effort level | 17, 18 |
| `--ff-fs-display` | 22px | page titles | 20, 21, 22 |
| `--ff-fs-hero` | 26px | welcome and empty-state titles | 24, 26, 28 |

Not changed:

- Reply body text keeps `--ff-chat-font-size`, the user's own setting (default 14px). The reply's markdown headings are fixed sizes and move onto the scale (an h2 goes from 20px to 22px).
- Display numbers that are artwork rather than text, such as the 50px and 60px weather temperatures.
- Sizes set in TS: one `fontSize` (`code-highlight-theme.ts`, 13px), already on the scale. The code-rain canvas keeps its own font: it is artwork.
- The splash screen (`public/splash.html`) is a standalone page without the tokens and keeps its own sizes.

The smallest text becomes 12px. Text that was 10–11.5px grows by 0.5–2px. Rows with fixed heights (tick rows, badges, chips) are checked one by one so nothing clips.

## Families

- Sans: `--rb-font-sans` stays the one sans stack (`ui/theme.ts` sets the same stack at runtime, so both change together): `"Noto Sans SC Variable", "Noto Sans SC", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`. CodeGitPanel uses it. The weather card keeps its own font, because it belongs to the card's artwork.
- Mono: `--rb-font-mono` becomes the one mono stack: `"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, "Noto Sans SC Variable", monospace`. The CJK font at the end keeps Chinese in code comments from falling back to SimSun. Code blocks, diff, Git chips, the slash menu and the settings fields all use it.
- Weights stay as they are (Noto Sans SC is variable, 300–700).

## Work order

1. Add the tokens and switch `fonts.css` to the bundled packages. Confirm that every HTML entry (react, settings, sidebar, toast, sticker-manager, react-perf) still loads them after `vite build`, and that the built app makes no request to fonts.googleapis.com.
2. Replace sizes file by file, settings first (the most rules), then the chat components. One commit per area, so a regression can be bisected.
3. Unify the mono stacks.
4. Screenshots before and after for Chat, Work and Code, settings, the effort panel and the sidebar, in the light and dark themes.

## Full check, then packaging (owner's request)

After the font PR, a full feature check on the integrated build with a real model:

- memory: write, recall, forget/correct, history origins;
- harness and agent loop: a multi-round Work task with tools, retries and a cancelled run;
- subagent: a delegated task and its result in the parent;
- graph: the knowledge graph view and its updates;
- MCP: a configured server's tools listed and called;
- browser: the built-in browser tools (open, read, click) and the Playwright MCP from the packaged build (it runs unpacked from asar).

Then `npm run package:win` and `npm run verify:installer`, install the result in a clean profile, and repeat a short smoke run (open, chat, one Code task, the browser) from the installed app. Failures found in the check are fixed before packaging and reported with their logs.
