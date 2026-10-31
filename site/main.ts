// 宣传页脚本：中英切换、深浅色（同步给演示页）、演示随宽度整体缩放、功能展示与常见问题的页签、复制安装命令，
// 以及演示页传来的"桌面版功能"提示。
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";
import chatShot from "../readme-assets/screenshots/chat.webp";
import workShot from "../readme-assets/screenshots/work.webp";
import codeShot from "../readme-assets/screenshots/code.webp";
import memoryShot from "../readme-assets/screenshots/memory-graph.png";

type Lang = "zh" | "en";
type Theme = "light" | "dark";

const EN: Record<string, string> = {
  "nav.label": "Page navigation", "nav.demo": "Try it", "nav.features": "Features", "nav.extend": "Extend", "nav.faq": "FAQ",
  "nav.github": "GitHub", "nav.theme": "Toggle theme", "nav.download": "Download",
  "hero.kicker": "AI desktop companion",
  "hero.lede": "Chats with you. Gets things done. Firefly is a Live2D character who lives on your Windows desktop, and an agent that reads and writes files, changes code and runs commands. You see every step it takes and everything it needs you to approve.",
  "hero.download": "Download for Windows", "hero.source": "View the source",
  "hero.meta": "Free and open source (MIT) · Windows 10 / 11 · Uses your own model service",
  "demo.title": "Try it online", "demo.iframeTitle": "Firefly online demo",
  "demo.hint": "This is the desktop app's own UI. Switch between Chat, Work and Code at the top left, then send a message to see how Firefly answers and asks for your approval. Replies are scripted: no model calls, no network.",
  "demo.open": "Open full screen",
  "entries.label": "Get started",
  "entries.app.title": "Desktop app", "entries.app.body": "An installer for Windows 10 / 11. Live2D Firefly stays on your desktop, with Chat, Work and Code in one window.",
  "entries.app.action": "Download for Windows",
  "entries.sdk.title": "Plugin SDK", "entries.sdk.body": "Write plugins in TypeScript that talk to Firefly only through public interfaces. The npm package carries provenance.",
  "entries.sdk.copy": "Copy the install command",
  "entries.market.title": "Skills and plugin market", "entries.market.body": "Install from settings. Skills install only reviewed versions; plugins are checked against their SHA-256 and start disabled.",
  "entries.market.action": "Browse the plugin market",
  "stack.label": "Built on", "stack.title": "Built on these open-source projects",
  "showcase.title": "From one message to the job done", "showcase.label": "Features",
  "showcase.chat.title": "Talk with Firefly",
  "showcase.chat.body": "In-character chat with streamed replies, and Live2D Firefly in the corner of your desktop. The built-in browser opens on the right, and the overview cards show context and usage.",
  "showcase.work.title": "Partners working in parallel",
  "showcase.work.body": "Firefly splits a task between Blade and Dan Heng, checks their answers against the sources and combines them. Each partner's run result is on the right.",
  "showcase.code.title": "Fix a bug, add a test",
  "showcase.code.body": "The run folds into one summary line: files read, commands run, what changed and what failed. The branch, changes and run results are on the right.",
  "showcase.memory.title": "Memory graph",
  "showcase.memory.body": "Memory stays on your machine. Settings show which category each memory belongs to and which conversation it came from; open one to confirm, correct or forget it.",
  "safety.title": "A character, with clear limits",
  "safety.approve.title": "Asks before it acts",
  "safety.approve.body": "Writes, commands and network actions run under permission levels, need your approval and can be cancelled. The character's tone never loosens these rules.",
  "safety.local.title": "Memory stays local",
  "safety.local.body": "Settings, history and memory live in SQLite on your machine, and the memory database key is protected by Windows DPAPI. Conversations go only to the model service you choose.",
  "safety.verify.title": "Checked before install",
  "safety.verify.body": "Skills install only reviewed versions pinned to a commit with matching content. Plugins are checked against their SHA-256 and stay disabled until you turn them on.",
  "extend.title": "Extend Firefly",
  "extend.skills.title": "Skills market", "extend.skills.body": "Give Firefly new ways of working, such as research, study and writing skills, published as reviewed, pinned versions.",
  "extend.plugins.title": "Plugin market", "extend.plugins.body": "Plugins ship as archives with a SHA-256 and start disabled; their permissions are listed at install time.",
  "extend.sdk.title": "Write your own plugin", "extend.sdk.body": "The plugin SDK is on npm, with runnable examples in the repository. Plugins talk to Firefly only through public interfaces.",
  "extend.mcp.title": "Connect MCP servers", "extend.mcp.body": "Add a server started by a local command (stdio), or a remote address (Streamable HTTP).",
  "closing.title": "Keep your ideas moving",
  "closing.body": "Download the Windows desktop app, add your own model service on first launch, and you're ready.",
  "closing.download": "Go to GitHub Releases", "closing.try": "Try the demo first",
  "faq.title": "Frequently asked questions", "faq.label": "Question categories",
  "faq.tab.use": "Using it", "faq.tab.privacy": "Privacy and safety", "faq.tab.extend": "Extending it",
  "faq.cost.q": "Does it cost anything?",
  "faq.cost.a": "The app and its source are free (MIT). Conversations use the model service you configure, and that provider bills you for it.",
  "faq.os.q": "Which systems does it run on?", "faq.os.a": "Windows 10 / 11 (x64) for now; that is the main development and test platform.",
  "faq.model.q": "Which models can I use?",
  "faq.model.a": "It ships with an OpenRouter preset and works with services compatible with Chat Completions. Whether it can read images depends on the model.",
  "faq.ip.q": "Is it affiliated with Honkai: Star Rail?",
  "faq.ip.a": "No. This is an unofficial, non-commercial fan project; the characters and IP belong to HoYoverse / miHoYo and the respective rights holders.",
  "faq.data.q": "Where is my data kept?",
  "faq.data.a": "Settings, history and memory stay on your machine (%APPDATA%\\Firefly by default), and the memory database key is protected by Windows DPAPI. Conversations go to the model service you choose.",
  "faq.safe.q": "Can the agent change files on its own?",
  "faq.safe.a": "Writes, commands and network actions run under permission levels, need your approval, and can be cancelled at any time. Approving a site in the browser never grants the agent anything.",
  "faq.demo.q": "Does the online demo send what I type anywhere?",
  "faq.demo.a": "No. The demo makes no network requests, its replies are written in advance, and reloading the page clears it.",
  "faq.market.q": "How do I add Skills and plugins?",
  "faq.market.a": "Install them from the Skills market and the plugin market in settings. Skills install only reviewed versions, plugins are checked against their SHA-256, and both start disabled until you turn them on.",
  "faq.sdk.q": "Can I write my own plugin?",
  "faq.sdk.a": "Yes. The plugin SDK is on npm (@firefly_wu/plugin-sdk) with runnable examples in the repository (examples/); plugins talk to Firefly only through public interfaces.",
  "faq.mcp.q": "Can it use MCP servers?", "faq.mcp.a": "Yes: add a server started by a local command (stdio), or a remote address (Streamable HTTP).",
  "footer.tagline": "Chats with you. Gets things done.", "footer.projects": "Projects", "footer.help": "Help",
  "footer.issues": "Report an issue", "footer.releases": "Releases", "footer.legal": "Licenses",
  "footer.license": "The source code is MIT licensed; third-party dependencies, models, images and character assets follow their own licenses.",
  "footer.ip": "Firefly and Honkai: Star Rail characters and IP belong to HoYoverse / miHoYo and the respective rights holders. This is an unofficial, non-commercial fan project; derivatives containing the Firefly character or character art may not be used commercially.",
  "footer.notices": "Third-party and asset notices", "footer.siteLicenses": "Open-source licenses in this page",
  "footer.demoLicenses": "Open-source licenses in the online demo",
};
const TOAST: Record<Lang, Record<"desktopOnly" | "copied" | "copyFailed", string>> = {
  zh: { desktopOnly: "这个功能需要在桌面版里使用。", copied: "已复制安装命令。", copyFailed: "复制失败，请手动选择命令。" },
  en: { desktopOnly: "That part needs the desktop app.", copied: "Install command copied.", copyFailed: "Couldn't copy; select the command by hand." },
};

const SHOTS: Record<string, string> = { chat: chatShot, work: workShot, code: codeShot, memory: memoryShot };
/** Below this width the demo keeps its desktop layout and is shrunk as a whole. */
const DEMO_MIN_WIDTH = 1100;
const DEMO_HEIGHT = 760;

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 只在本次有效 */ } };

// The Chinese text is the HTML itself; remember it so switching back restores it exactly.
const original = new Map<Element, { text?: string; label?: string; alt?: string; title?: string }>();
for (const element of document.querySelectorAll("[data-i18n],[data-i18n-label],[data-i18n-alt],[data-i18n-title]")) {
  original.set(element, {
    text: element.hasAttribute("data-i18n") ? element.textContent ?? "" : undefined,
    label: element.getAttribute("aria-label") ?? undefined,
    alt: element.getAttribute("alt") ?? undefined,
    title: element.getAttribute("title") ?? undefined,
  });
}

let lang: Lang = read("ff-site-lang") === "en" || (!read("ff-site-lang") && !navigator.language.toLowerCase().startsWith("zh")) ? "en" : "zh";
// Dark is the page's own look; light only when the visitor picked it.
let theme: Theme = read("ff-site-theme") === "light" ? "light" : "dark";

const frame = document.getElementById("demo-iframe") as HTMLIFrameElement;
const demoUrl = () => `demo/web-demo/index.html?lang=${lang}&theme=${theme}`;

function toast(key: keyof (typeof TOAST)["zh"]): void {
  const element = document.getElementById("toast")!;
  element.textContent = TOAST[lang][key];
  element.dataset.show = "";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { delete element.dataset.show; }, 2600);
}
let toastTimer: number | undefined;

function applyLang(): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const [element, saved] of original) {
    const pick = (attribute: string, fallback?: string) => {
      const key = element.getAttribute(attribute);
      return lang === "en" && key && EN[key] ? EN[key] : fallback;
    };
    if (saved.text !== undefined) element.textContent = pick("data-i18n", saved.text) ?? "";
    const label = pick("data-i18n-label", saved.label); if (label) element.setAttribute("aria-label", label);
    const alt = pick("data-i18n-alt", saved.alt); if (alt) element.setAttribute("alt", alt);
    const title = pick("data-i18n-title", saved.title); if (title) element.setAttribute("title", title);
  }
  const toggle = document.getElementById("lang-toggle")!;
  toggle.textContent = lang === "zh" ? "EN" : "中";
  toggle.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换到中文");
  // The demo's language is fixed at load, so a language change reloads it (with the current theme).
  if (frame.getAttribute("src") !== demoUrl()) frame.setAttribute("src", demoUrl());
  document.getElementById("demo-open")!.setAttribute("href", demoUrl());
  syncShowcaseAlt();
}

const sendDemoTheme = () => frame.contentWindow?.postMessage({ type: "firefly-demo:theme", theme }, window.location.origin);
// A message sent while the demo is still loading arrives before it listens, so send the current theme again once it has loaded.
frame.addEventListener("load", sendDemoTheme);

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
  // The loaded demo switches in place; "open full screen" carries the choice in its address.
  sendDemoTheme();
  document.getElementById("demo-open")!.setAttribute("href", demoUrl());
}

// Keep the demo at its desktop layout and shrink it to fit narrow screens, so phones never scroll it sideways.
const viewport = document.getElementById("demo-viewport")!;
function fitDemo(): void {
  const width = viewport.clientWidth;
  const scale = Math.min(1, width / DEMO_MIN_WIDTH);
  viewport.style.setProperty("--demo-width", `${Math.max(width, DEMO_MIN_WIDTH)}px`);
  viewport.style.setProperty("--demo-scale", String(scale));
  viewport.style.setProperty("--demo-height", `${Math.round(DEMO_HEIGHT * scale)}px`);
}
new ResizeObserver(fitDemo).observe(viewport);

/** Arrow keys move between tabs and Home/End jump to the ends, as in the WAI-ARIA tabs pattern. */
function tabKeys(tabs: HTMLElement[], select: (tab: HTMLElement) => void) {
  for (const tab of tabs) tab.addEventListener("keydown", (event) => {
    const at = tabs.indexOf(tab);
    const step = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : step ? tabs[(at + step + tabs.length) % tabs.length] : undefined;
    if (!target) return;
    event.preventDefault();
    select(target);
    target.focus();
  });
}

// Showcase: the selected feature opens in the list and its screenshot fills the frame beside it.
const showcaseTabs = [...document.querySelectorAll<HTMLButtonElement>(".accordion-item")];
const showcaseImage = document.getElementById("showcase-image") as HTMLImageElement;
const showcasePanel = document.getElementById("showcase-panel")!;
function syncShowcaseAlt(): void {
  const selected = showcaseTabs.find(tab => tab.getAttribute("aria-selected") === "true");
  showcaseImage.alt = selected?.querySelector("strong")?.textContent ?? "";
}
function selectShowcase(tab: HTMLElement): void {
  for (const other of showcaseTabs) {
    const active = other === tab;
    other.setAttribute("aria-selected", String(active));
    other.tabIndex = active ? 0 : -1;
  }
  showcasePanel.setAttribute("aria-labelledby", tab.id);
  const next = new URL(SHOTS[tab.dataset.key ?? "chat"]!, window.location.href).href;
  syncShowcaseAlt();
  if (showcaseImage.src === next) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { showcaseImage.src = next; return; }
  showcaseImage.dataset.fading = "";
  window.setTimeout(() => {
    showcaseImage.src = next;
    showcaseImage.addEventListener("load", () => { delete showcaseImage.dataset.fading; }, { once: true });
  }, 160);
}
for (const tab of showcaseTabs) tab.addEventListener("click", () => selectShowcase(tab));
tabKeys(showcaseTabs, selectShowcase);

// FAQ: one category of questions at a time.
const faqTabs = [...document.querySelectorAll<HTMLButtonElement>(".faq-tabs [role=tab]")];
function selectFaq(tab: HTMLElement): void {
  for (const other of faqTabs) {
    const active = other === tab;
    other.setAttribute("aria-selected", String(active));
    other.tabIndex = active ? 0 : -1;
    document.getElementById(other.getAttribute("aria-controls")!)!.hidden = !active;
  }
}
for (const tab of faqTabs) tab.addEventListener("click", () => selectFaq(tab));
tabKeys(faqTabs, selectFaq);

const copyButton = document.getElementById("copy-sdk") as HTMLButtonElement;
copyButton.addEventListener("click", () => {
  navigator.clipboard.writeText(copyButton.dataset.copy ?? "").then(() => toast("copied"), () => toast("copyFailed"));
});

document.getElementById("lang-toggle")!.addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh"; write("ff-site-lang", lang); applyLang();
});
document.getElementById("theme-toggle")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark"; write("ff-site-theme", theme); applyTheme();
});

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
  if ((event.data as { type?: string } | null)?.type !== "firefly-demo:desktop-only") return;
  toast("desktopOnly");
});

applyTheme();
applyLang();
fitDemo();
