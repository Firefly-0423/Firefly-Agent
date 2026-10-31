// 宣传页脚本：中英切换、深浅色、横幅随两者切换、功能展示与常见问题的页签，以及演示页传来的"桌面版功能"提示。
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";
import bannerLight from "./banner/firefly-banner-light.gif";
import bannerDark from "./banner/firefly-banner-dark.gif";
import bannerLightEn from "./banner/firefly-banner-light.en.gif";
import bannerDarkEn from "./banner/firefly-banner-dark.en.gif";
import chatShot from "../readme-assets/screenshots/chat.webp";
import workShot from "../readme-assets/screenshots/work.webp";
import codeShot from "../readme-assets/screenshots/code.webp";
import memoryShot from "../readme-assets/screenshots/memory-graph.png";

type Lang = "zh" | "en";
type Theme = "light" | "dark";

const EN: Record<string, string> = {
  "nav.label": "Page navigation", "nav.features": "Features", "nav.demo": "Try it", "nav.faq": "FAQ", "nav.download": "Download",
  "nav.github": "GitHub", "nav.theme": "Toggle theme",
  "hero.eyebrow": "Windows · Live2D · AI workbench",
  "hero.title": "Someone to talk to, and to get things done with",
  "hero.lede": "Firefly puts a desktop character who chats with you and an agent workbench that does real work in one window. You see every step it takes and everything it needs you to approve.",
  "hero.download": "Download for Windows", "hero.try": "Try it online",
  "hero.meta": "Free and open source (MIT) · Windows 10 / 11 · Uses your own model service",
  "hero.shotAlt": "Chat mode: talking with Firefly, the built-in browser on the right and the Live2D Firefly on the desktop",
  "modes.label": "Three modes", "modes.see": "See it →",
  "modes.chat.title": "Chat · Desktop companion", "modes.chat.body": "In-character chat with streamed replies; Live2D Firefly stays on your desktop.",
  "modes.work.title": "Work · Get tasks done", "modes.work.body": "Read and write files, sort documents, and hand work to partners in parallel.",
  "modes.code.title": "Code · Code workspace", "modes.code.body": "Read and change code, run commands and tests in a bound project.",
  "showcase.eyebrow": "The real app", "showcase.title": "Every step in plain sight", "showcase.label": "Features",
  "showcase.chat.title": "💬 Talk with Firefly",
  "showcase.chat.body": "The built-in browser is open on the right, the overview cards show context and usage (the total comes from the provider), and Live2D Firefly sits on the desktop.",
  "showcase.work.title": "📋 Partners working in parallel",
  "showcase.work.body": "Firefly splits a task between Blade and Dan Heng, checks their answers against the sources and combines them. Each partner's run result is on the right.",
  "showcase.code.title": "💻 Fix a bug, add a test",
  "showcase.code.body": "The run folds into one summary line: files read, commands run, what changed and what failed. The branch, changes and run results are on the right.",
  "showcase.memory.title": "🧠 Memory graph",
  "showcase.memory.body": "Memory stays on your machine. Settings show which category each memory belongs to and which conversation it came from; open one to confirm, correct or forget it.",
  "demo.eyebrow": "Try it online", "demo.title": "Try Firefly right here",
  "demo.lede": "This runs the same UI code as the desktop app. Switch between Chat, Work and Code at the top left, then send a message to see how Firefly answers and asks for your approval.",
  "demo.iframeTitle": "Firefly online demo",
  "demo.note1": "Browse and send messages", "demo.note2": "Messages stay in this page", "demo.note3": "Scripted replies, no model calls",
  "features.eyebrow": "What it does", "features.title": "A character, with clear limits",
  "features.chat.title": "💬 Chat · Desktop companion",
  "features.chat.body": "In-character chat with streamed replies. Live2D Firefly stays on your desktop with expressions and idle motions; temporary chats stay out of history.",
  "features.work.title": "📋 Work · Get tasks done",
  "features.work.body": "Read and write files, work with Word / Excel / PDF, search the web and set reminders. Each run folds into one summary line you can expand and check.",
  "features.code.title": "💻 Code · Code workspace",
  "features.code.body": "Read and change code in a bound project with Git, language servers, structural search and command tools. Changes and diffs sit on the right.",
  "features.memory.title": "🧠 Memory stays local",
  "features.memory.body": "Personal memory and history search live in SQLite on your machine. The memory graph in settings lets you confirm, correct or forget each entry.",
  "features.market.title": "🧩 Skills and plugin market",
  "features.market.body": "Skills install only as reviewed versions pinned to a commit and matching their content digest. Plugins are checked against their SHA-256 and start disabled.",
  "features.safety.title": "🔒 Careful by default",
  "features.safety.body": "Writes, commands and network actions go through permission levels and approval, and can be cancelled. The character's tone never loosens these rules.",
  "faq.eyebrow": "FAQ", "faq.title": "A few things worth knowing first", "faq.label": "Question categories",
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
  "faq.sdk.a": "Yes. The repository has the plugin SDK (plugin-sdk/) and runnable examples (examples/); plugins talk to Firefly only through public interfaces.",
  "faq.mcp.q": "Can it use MCP servers?", "faq.mcp.a": "Yes: add a server started by a local command (stdio), or a remote address (Streamable HTTP).",
  "closing.bannerAlt": "Firefly-Agent: a Firefly desktop companion and AI workbench",
  "closing.title": "Keep your ideas moving",
  "closing.body": "Download the Windows desktop app, add your own model service on first launch, and you're ready.",
  "closing.download": "Go to GitHub Releases", "closing.source": "View the source",
  "footer.tagline": "A Firefly desktop companion and AI workbench", "footer.projects": "Projects", "footer.help": "Help",
  "footer.issues": "Report an issue", "footer.releases": "Releases", "footer.legal": "Licenses",
  "footer.license": "The source code is MIT licensed; third-party dependencies, models, images and character assets follow their own licenses.",
  "footer.ip": "Firefly and Honkai: Star Rail characters and IP belong to HoYoverse / miHoYo and the respective rights holders. This is an unofficial, non-commercial fan project; derivatives containing the Firefly character or character art may not be used commercially.",
  "footer.notices": "Third-party and asset notices", "footer.siteLicenses": "Open-source licenses in this page",
  "footer.demoLicenses": "Open-source licenses in the online demo",
  "toast.desktopOnly": "That part needs the desktop app.",
};
const ZH_TOAST = "这个功能需要在桌面版里使用。";

const SHOTS: Record<string, string> = { chat: chatShot, work: workShot, code: codeShot, memory: memoryShot };

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
let theme: Theme | null = read("ff-site-theme") === "dark" ? "dark" : read("ff-site-theme") === "light" ? "light" : null;
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const resolvedTheme = (): Theme => theme ?? (systemDark.matches ? "dark" : "light");

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
  const frame = document.getElementById("demo-iframe") as HTMLIFrameElement;
  const next = `demo/web-demo/index.html?lang=${lang}`;
  if (!frame.getAttribute("src")?.endsWith(`lang=${lang}`)) frame.setAttribute("src", next);
  applyBanner();
  syncShowcaseAlt();
}

function applyBanner(): void {
  const dark = resolvedTheme() === "dark";
  const banner = document.getElementById("hero-banner") as HTMLImageElement;
  banner.src = lang === "en" ? (dark ? bannerDarkEn : bannerLightEn) : (dark ? bannerDark : bannerLight);
}

function applyTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme();
  applyBanner();
}

/** Arrow keys move between tabs and Home/End jump to the ends, as in the WAI-ARIA tabs pattern. */
function tabKeys(tabs: HTMLElement[], select: (tab: HTMLElement) => void, vertical: boolean) {
  for (const tab of tabs) tab.addEventListener("keydown", (event) => {
    const at = tabs.indexOf(tab);
    const step = (vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 })[event.key as "ArrowDown"];
    const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : step ? tabs[(at + step + tabs.length) % tabs.length] : undefined;
    if (!target) return;
    event.preventDefault();
    select(target);
    target.focus();
  });
}

// Showcase: the selected feature's screenshot fills the window on the right.
const showcaseTabs = [...document.querySelectorAll<HTMLButtonElement>(".showcase-item")];
const showcaseImage = document.getElementById("showcase-image") as HTMLImageElement;
const showcasePanel = document.getElementById("showcase-panel")!;
function syncShowcaseAlt(): void {
  const selected = showcaseTabs.find(tab => tab.getAttribute("aria-selected") === "true");
  showcaseImage.alt = selected?.querySelector("strong")?.textContent?.replace(/^\S+\s/, "") ?? "";
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
tabKeys(showcaseTabs, selectShowcase, true);
// "See it" on a mode card opens that feature in the showcase.
for (const link of document.querySelectorAll<HTMLButtonElement>("[data-show]")) {
  link.addEventListener("click", () => {
    const tab = showcaseTabs.find(item => item.dataset.key === link.dataset.show);
    if (!tab) return;
    selectShowcase(tab);
    document.getElementById("showcase")!.scrollIntoView();
  });
}

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
tabKeys(faqTabs, selectFaq, false);

document.getElementById("lang-toggle")!.addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh"; write("ff-site-lang", lang); applyLang();
});
document.getElementById("theme-toggle")!.addEventListener("click", () => {
  theme = resolvedTheme() === "dark" ? "light" : "dark"; write("ff-site-theme", theme); applyTheme();
});
systemDark.addEventListener("change", () => { if (!theme) applyTheme(); });

let toastTimer: number | undefined;
window.addEventListener("message", (event) => {
  const frame = document.getElementById("demo-iframe") as HTMLIFrameElement;
  if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
  if ((event.data as { type?: string } | null)?.type !== "firefly-demo:desktop-only") return;
  const toast = document.getElementById("toast")!;
  toast.textContent = lang === "zh" ? ZH_TOAST : EN["toast.desktopOnly"]!;
  toast.dataset.show = "";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { delete toast.dataset.show; }, 2600);
});

applyTheme();
applyLang();
