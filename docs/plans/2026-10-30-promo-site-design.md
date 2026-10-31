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

## Decisions after review (2026-10-30)

- The user approved the Pages deploy workflow (`.github/workflows/pages.yml`) and publishing the 1.1.0 installer as a GitHub Release.
- The site is named "Firefly-Agent". Its banners are the README banners with that title (`site/banner/`); the README and the app keep "Firefly_Agent". Superseded on 2026-10-31: the README banners were redesigned with the "Firefly-Agent" title, and the site now uses them directly from `readme-assets/`.
- The demo build swaps the delegated-partner portraits for a stub, so no other character's artwork is published with the site. The only image it ships is the Firefly avatar. Superseded on 2026-10-31: at the user's request the landing page shows the twelve partners with small copies of their portraits (`site/partners/`); the demo build still ships none.
- Until the domain is ready, the site is served at the repository's github.io address.

## Hosting on Cloudflare (2026-10-31)

At the user's request the site moved to Cloudflare at `hotarufirefly.online`, whose DNS is in the user's Cloudflare account. It is a static-assets Worker (`wrangler.jsonc`: `dist/site`, no script, `workers_dev` and preview URLs off) with the apex and `www` as custom domains, so Cloudflare creates their DNS records and certificates. `.github/workflows/site.yml` replaces `pages.yml`: on `main` it builds the site and runs `cloudflare/wrangler-action@v4` with a pinned Wrangler version. The repository only needs `contents: read`; the API token and account ID live in the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, which the user creates. The token uses the "Edit Cloudflare Workers" template limited to that account and zone. The github.io copy stops updating; turning GitHub Pages off is left to the user.

## Layout revision (2026-10-31)

At the user's request the landing page follows the structure of GitHub's Copilot product page (github.com/features/copilot, checked 2026-10-31): a two-column hero with a product screenshot, three mode cards, a scrolling strip, a feature list on the left that switches the screenshot on the right, the live demo, a feature grid, FAQ in category tabs, a closing band with the banner, and a multi-column footer. The screenshots are the README ones (`readme-assets/screenshots/`). Only the structure is borrowed; no copy or assets come from that page.

## Open items

- The domain name and its registrar, so DNS and the Pages custom domain can be set up.

## Second layout revision (2026-10-31)

The user found the first version still plain and asked for a closer follow of github.com/features/copilot, without the banner, and for a page that works on a phone held upright.

- Dark by default (light stays as a toggle). The page column has hairlines down both sides; blocks are separated by rules and their content is cut into cells by hairlines.
- The hero is a mono kicker with a blinking block cursor and the product name on the left, the pitch and buttons on the right. The live demo sits right under it in a glowing frame, in place of a product screenshot.
- Then three ways in (desktop app, plugin SDK with a copyable `npm i`, the Skills and plugin market), the technology strip, the feature accordion beside the real screenshots, three safety cells, a 2×2 "Extend Firefly" grid, a closing panel, and the FAQ with mono categories on the left.
- The demo keeps its desktop layout and shrinks as a whole below 1100 px wide, so phones never scroll it sideways; an "open full screen" link opens it alone. Its theme follows the page (`theme` URL parameter, then a `firefly-demo:theme` message).
- Inside the page, the demo's `focus()` and `scrollIntoView()` no longer move the host page (`src/renderer/web-demo/host-scroll.ts`). Before this, opening the mode menu pulled the page to the top, because Ant Design focuses the menu while it is still parked off-screen.

## Partners and motion (2026-10-31)

The user asked to replace the scrolling technology strip with the twelve partners, to add motion and hover feedback, and to show Firefly's avatar.

- The strip became a "Firefly and 12 partners" section: Firefly as the lead agent, then two rows of partner cards scrolling in opposite directions; hovering a row stops it. The cards are built by `site/main.ts` from `src/shared/specialist-agents.ts`, so the Chinese names, roles and intros match the app's settings page; the English ones are in `site/partners.ts`. The portraits are 192 px WebP copies of `src/renderer/assets/task-portraits/` (about 200 KB for all twelve), named by partner id. `src/main/site-partners.test.ts` checks that every partner has a portrait and English text, and that the heading's count matches.
- The hero leads with Firefly's avatar in a turning ring; clicking it makes her hop and say one of three lines. Fireflies drift behind the hero and the closing panel, the title catches a slow sheen, and a light runs round the demo's border.
- Hover: a soft light follows the pointer across cards (mouse and pen only), icon tiles tip, buttons lift and the primary one glints, the arrows in the link cells fill in, nav links underline, and the screenshot frame lifts.
- Blocks rise in the first time they scroll into view, then drop the classes that did it. With reduced motion none of this runs, and the partners sit still in a wrapped grid, each shown once.
- Follow-up from the user's review: the page column widened from 1280 to 1760 px, and on wide screens the demo grows taller with its width (60 % of it, 760 to 940 px). The first "ways in" card no longer repeats the hero's download button; it shows the three modes as small blocks that jump to the demo. Sections carry a mono eyebrow over their titles. Each safety cell opens with a small mock of the app (an approval prompt, local storage, install checks), and the extend cells have a filled gradient tile, the icon repeated large and faint in the corner, and a tag naming where the link goes. The hero title keeps room below the line, because `background-clip: text` cut off the descender of the g. Cell grids rise in as a whole, so the hairline background never shows through a fading cell.
- With a mouse, resting on a feature or an FAQ category for 120 ms opens it, so visitors no longer need to click; touch and keyboard still select by tap, click or arrow keys. The four features now share the screenshot's height, numbered 01 to 04, with the open one taking the most room. The FAQ categories became blocks that fill their column, each with its question count and a line on what it covers; on phones they sit in a row of three.
- The switches were too abrupt, so every one now moves on a single easing curve (`--ease`). An opening feature grows to its text's height and then fades the text in, while its accent bar grows from the middle. The four screenshots sit stacked in the frame and crossfade, so nothing loads on a switch. An FAQ category's questions rise in one after another, answers open by height in browsers that animate to `auto`, and the theme toggle fades the whole page through a view transition. The hero's padding is tighter (56 / 44 px).
