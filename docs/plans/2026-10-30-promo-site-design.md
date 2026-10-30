# Promo site with a live UI demo

## Goal

A public site for Firefly on the user's own domain. It introduces the product and links to the download and the repositories. Its centre is a panel that runs Firefly's real React UI in the browser. Visitors can switch modes, send messages and open the overview cards. Replies are scripted; nothing calls a model or leaves the page.

The reference is Cyrene's site (playaagentcyrene.online, checked 2026-10-30). It has a hero, a provider strip, an embedded desktop UI with fixed demo replies ("消息只保存在当前页面", "固定演示回复，不调用模型"), a feature carousel, and download and docs links.

User decisions (2026-10-30):
- own domain;
- real UI with scripted replies;
- the Live2D GIF banners only, no live model on the web.

## Where the code lives

Both parts go in this repository:
- `src/renderer/web-demo/`: the demo entry. It reuses `App` and `AppProviders` and installs fake bridges, like `src/renderer/react-perf/` does.
- `site/`: the landing page, a small Vite build that embeds the demo build.

Keeping the demo next to the UI means a UI change shows up in the demo on the next build, and the demo's tests run in this repository's CI.

Rejected: a separate `firefly-site` repository that copies a built bundle. The copy drifts from the app, and its tests would not run against UI changes.

## Demo behaviour

- Start screen: one sample conversation per mode (Chat, Work, Code), in the sidebar under a sample project.
- Sending a message replays a scripted AG-UI run for the current mode through the same `AguiApi.onEvent` path the app uses:
  - streamed text;
  - Work: a tool timeline (read files, run a command);
  - Code: a file change with a diff and an approval card the visitor can approve or deny;
  - overview cards fill in (context, usage, outputs, changes).
- Fixed replies are chosen by mode and turn count, not by the message text, and say so in the UI.
- State lives in memory for the page. Reload starts over.
- Anything that needs the desktop (settings, folders, the browser panel, voice, plugins, MCP) is disabled with a "desktop only" hint, not faked.
- No network calls: no model, no API key, no analytics. Fonts and assets are bundled. A strict CSP allows only the site's own origin.

## Landing page

Sections:
1. Hero with the existing banner GIFs and the motto.
2. The live demo, with the three notes "可试发消息 / 消息只保存在当前页面 / 固定演示回复，不调用模型".
3. Feature cards, taken from the README: Chat / Work / Code, memory, Skills and plugins market, safety.
4. Download: the Windows installer from GitHub Releases, plus the system requirements.
5. Footer: repositories, licence, character IP notice and disclaimer (as in `THIRD_PARTY_NOTICES.md`).

Chinese by default, with an English switch. Light and dark themes follow the app's tokens. It works at phone width; the demo panel scrolls sideways on narrow screens instead of shrinking the app.

## Hosting

The site is static, so any static host works. Recommended: GitHub Pages deployed by a workflow on `main`, with the user's domain set as the custom domain (CNAME). Cloudflare Pages is the alternative if access from mainland China needs to be faster.

Adding a deploy workflow changes CI, so the workflow is added only after the user confirms it. A domain served from outside mainland China needs no ICP filing; a mainland host would.

## Tests and checks

- Unit tests for the demo bridges and scripts: each mode's run ends with `RUN_FINISHED`, approval and deny both settle, and no bridge method issues a network request.
- A build check that the demo bundle contains no `fetch`/`WebSocket` to other origins and no Live2D model files.
- Manual check in a browser at desktop and phone widths.

## Open items for the user

- The domain name and its registrar, so DNS can be set up.
- Whether to publish the 1.1.0 installer as a GitHub Release. There is no release yet, and the download button needs one.
- Approval to add the Pages deploy workflow.
