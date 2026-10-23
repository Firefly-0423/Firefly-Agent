# Window browser tools

The "more" menu, find bar, downloads and settings page of the window browser. Presentation lives in
`src/renderer/react/features/chat/workspace/` (`useBrowserChrome`, `BrowserToolsMenu`, `BrowserFindBar`,
`BrowserSettingsPanel`); everything that acts on a page or the disk lives in Main.

## Authority

- One command, `{ kind: "tool", tabId?, request }`, on the existing workspace channel. `parseBrowserToolRequest`
  (`src/shared/browser-tools.ts`) refuses unknown keys, wrong types and oversize values.
- Tab tools run only through `service.useTab`, which requires a current owner, a live page and an
  **ordinary-browsing grant** (`mode: "manual", web: true`). Host-limited, private-network and Agent grants get
  `permission_denied`. Window-wide requests (downloads, settings) need only the window's own renderer.
- The renderer never receives cookie names or values, full download URLs, or the full path of the save folder.

## Tools

| Tool | What Main does |
| --- | --- |
| find / stop-find | `findInPage` / `stopFindInPage`; results are pushed on `found-in-page` |
| zoom | preset stops 25-500 %, `setZoomFactor` |
| device | `enableDeviceEmulation` (phone, tablet) plus a matching user agent, restored on "off" |
| print | system print dialog |
| screenshot | capture, then the native "save as" dialog; nothing is written without that choice |
| snapshot | small JPEG data URL, shown in place of the page while a menu hides it |
| history | this tab's navigation entries (titles bounded, newest first) |
| cookies | per-domain **counts** for this tab's session only |
| clear-data | cookies (all, or one domain), cache, site storage for this tab's session |
| download | list, open, reveal, cancel, remove, clear |
| settings | ask-where-to-save, save folder (native folder picker) |

Each tab has its own in-memory session, so cookies and storage are per tab and disappear with it. There is no cookie
import and no password storage.

## Downloads

The session still refuses every download. `will-download` is offered to the composition (`acceptDownload`) only for a
current ordinary-browsing page, and `browser-downloads` then accepts it only when:

- the user triggered it (`hasUserGesture()`), and every URL in the redirect chain is HTTPS without credentials;
- at most 3 downloads run at once and the announced or received size stays under 2 GiB;
- the file name is sanitised (no path parts, control or reserved characters, device names; bounded length).

Files are saved with a unique name into the chosen folder (default: the system Downloads folder), or the system dialog
decides when "ask where to save" is on. Nothing is opened automatically. File types that can run code (`.exe`, `.bat`,
`.ps1`, `.js`, `.lnk`, ... judged on every extension in the name) can only be shown in their folder.

## Native page and menus

The page is a native view above the DOM, so a menu cannot be drawn over it. While a menu, popover or the settings page
is open the page is detached (the same `layout` command with `bounds: null`) and a snapshot stands in. Print and
screenshot close the menu first and wait for the page to be attached again.

## Tests

`src/shared/browser-tools.test.ts`, `src/main/browser/browser-{download-policy,downloads,guest-tools,tools-hub}.test.ts`,
`manual-browser-tools.test.ts` (authority and routing), `browser-network-binding.test.ts` (download hook), and the
renderer tests `BrowserTools.test.ts`, `useBrowserChrome.test.ts`, `ManualBrowserTab.tools.test.ts`.
