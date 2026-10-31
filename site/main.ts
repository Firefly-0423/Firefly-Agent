// 宣传页脚本：中英切换、深浅色（同步给演示页）、演示随宽度整体缩放、伙伴卡片、功能展示与常见问题的页签、复制安装命令，
// 演示页传来的"桌面版功能"提示，以及动效：萤火、跟随指针的光、滚动进入时浮现、点头像打招呼。
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";
import chatShot from "../readme-assets/screenshots/chat.webp";
import workShot from "../readme-assets/screenshots/work.webp";
import codeShot from "../readme-assets/screenshots/code.webp";
import memoryShot from "../readme-assets/screenshots/memory-graph.png";
import { SPECIALIST_AGENTS, type SpecialistDefinition } from "../src/shared/specialist-agents";
import { PARTNERS_EN } from "./partners";

const PORTRAITS = import.meta.glob<string>("./partners/*.webp", { eager: true, query: "?url", import: "default" });

type Lang = "zh" | "en";
type Theme = "light" | "dark";

const EN: Record<string, string> = {
  "nav.label": "Page navigation", "nav.demo": "Try it", "nav.team": "Partners", "nav.features": "Features", "nav.extend": "Extend", "nav.faq": "FAQ",
  "nav.github": "GitHub", "nav.theme": "Toggle theme", "nav.download": "Download",
  "hero.avatar": "Say hi to Firefly", "hero.kicker": "AI desktop companion",
  "hero.lede": "Chats with you. Gets things done. Firefly is a Live2D character who lives on your Windows desktop, and an agent that reads and writes files, changes code and runs commands. You see every step it takes and everything it needs you to approve.",
  "hero.download": "Download for Windows", "hero.source": "View the source",
  "hero.meta": "Free and open source (MIT) · Windows 10 / 11 · Uses your own model service",
  "demo.title": "Try it online", "demo.iframeTitle": "Firefly online demo",
  "demo.hint": "This is the desktop app's own UI. Switch between Chat, Work and Code at the top left, then send a message to see how Firefly answers and asks for your approval. Replies are scripted: no model calls, no network.",
  "demo.open": "Open full screen",
  "entries.label": "Get started",
  "entries.modes.title": "Three modes, one window",
  "entries.modes.body": "Live2D Firefly stays on your desktop; chatting, handing work to partners and changing code all switch within one window.",
  "entries.modes.label": "Try the three modes in the demo", "entries.modes.chat": "Chat", "entries.modes.work": "Work", "entries.modes.code": "Code",
  "entries.sdk.title": "Plugin SDK", "entries.sdk.body": "Write plugins in TypeScript that talk to Firefly only through public interfaces. The npm package carries provenance.",
  "entries.sdk.copy": "Copy the install command",
  "entries.market.title": "Skills and plugin market", "entries.market.body": "Install from settings. Skills install only reviewed versions; plugins are checked against their SHA-256 and start disabled.",
  "entries.market.action": "Browse the plugin market",
  "team.eyebrow": "Lead + partners", "team.title": "Firefly and 12 partners",
  "team.body": "In Work and Code modes, Firefly splits a task, hands the pieces to the partners suited to them to run in parallel, then checks and combines what comes back. Each partner can use its own model.",
  "team.lead.name": "Firefly", "team.lead.role": "Lead agent · splits, delegates, checks",
  "showcase.eyebrow": "Features", "showcase.title": "From one message to the job done", "showcase.label": "Features",
  "showcase.chat.title": "Talk with Firefly",
  "showcase.chat.body": "In-character chat with streamed replies, and Live2D Firefly in the corner of your desktop. The built-in browser opens on the right, and the overview cards show context and usage.",
  "showcase.work.title": "Partners working in parallel",
  "showcase.work.body": "Firefly splits a task between Blade and Dan Heng, checks their answers against the sources and combines them. Each partner's run result is on the right.",
  "showcase.code.title": "Fix a bug, add a test",
  "showcase.code.body": "The run folds into one summary line: files read, commands run, what changed and what failed. The branch, changes and run results are on the right.",
  "showcase.memory.title": "Memory graph",
  "showcase.memory.body": "Memory stays on your machine. Settings show which category each memory belongs to and which conversation it came from; open one to confirm, correct or forget it.",
  "safety.eyebrow": "Safety", "safety.title": "A character, with clear limits",
  "safety.approve.mock.ask": "Firefly wants to run a command", "safety.approve.mock.deny": "Deny", "safety.approve.mock.allow": "Approve",
  "safety.local.mock.settings": "Settings and history", "safety.local.mock.local": "On this PC", "safety.local.mock.memory": "Memory database",
  "safety.verify.mock.pinned": "Pinned commit", "safety.verify.mock.match": "Matches", "safety.verify.mock.after": "After install",
  "safety.verify.mock.off": "Off by default",
  "safety.approve.title": "Asks before it acts",
  "safety.approve.body": "Writes, commands and network actions run under permission levels, need your approval and can be cancelled. The character's tone never loosens these rules.",
  "safety.local.title": "Memory stays local",
  "safety.local.body": "Settings, history and memory live in SQLite on your machine, and the memory database key is protected by Windows DPAPI. Conversations go only to the model service you choose.",
  "safety.verify.title": "Checked before install",
  "safety.verify.body": "Skills install only reviewed versions pinned to a commit with matching content. Plugins are checked against their SHA-256 and stay disabled until you turn them on.",
  "extend.eyebrow": "Ecosystem", "extend.title": "Extend Firefly",
  "extend.skills.title": "Skills market", "extend.skills.body": "Give Firefly new ways of working, such as research, study and writing skills, published as reviewed, pinned versions.",
  "extend.plugins.title": "Plugin market", "extend.plugins.body": "Plugins ship as archives with a SHA-256 and start disabled; their permissions are listed at install time.",
  "extend.sdk.title": "Write your own plugin", "extend.sdk.body": "The plugin SDK is on npm, with runnable examples in the repository. Plugins talk to Firefly only through public interfaces.",
  "extend.mcp.title": "Connect MCP servers", "extend.mcp.body": "Add a server started by a local command (stdio), or a remote address (Streamable HTTP).",
  "closing.title": "Keep your ideas moving",
  "closing.body": "Download the Windows desktop app, add your own model service on first launch, and you're ready.",
  "closing.download": "Go to GitHub Releases", "closing.try": "Try the demo first",
  "faq.eyebrow": "FAQ", "faq.title": "Frequently asked questions", "faq.label": "Question categories",
  "faq.tab.use": "Using it", "faq.tab.privacy": "Privacy and safety", "faq.tab.extend": "Extending it",
  "faq.tab.use.note": "Cost, systems and models", "faq.tab.privacy.note": "Data, permissions and the online demo",
  "faq.tab.extend.note": "Skills, plugins and MCP",
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
const GREETINGS: Record<Lang, readonly string[]> = {
  zh: ["嗨，我是流萤。今天想一起做点什么？", "先在下面的演示里和我说句话吧。", "要做的事有点多？我叫上伙伴们一起。"],
  en: ["Hi, I'm Firefly. What shall we work on today?", "Say something to me in the demo below.", "A lot on your plate? I'll bring the partners in."],
};

const SHOTS: Record<string, string> = { chat: chatShot, work: workShot, code: codeShot, memory: memoryShot };
/** Below this width the demo keeps its desktop layout and is shrunk as a whole. */
const DEMO_MIN_WIDTH = 1100;
const DEMO_HEIGHT = 760;
/** On wide screens the demo grows taller with its width, like a real window, up to this height. */
const DEMO_MAX_HEIGHT = 940;

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

function toast(text: string): void {
  const element = document.getElementById("toast")!;
  element.textContent = text;
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
  renderPartners();
}

// Partners: two rows of six, each row written twice so its scroll loops without a seam.
const partners = document.getElementById("partners")!;
function renderPartners(): void {
  const rows = [SPECIALIST_AGENTS.slice(0, 6), SPECIALIST_AGENTS.slice(6)];
  partners.replaceChildren(...rows.map((agents, row) => {
    const marquee = document.createElement("div");
    marquee.className = row ? "marquee reverse" : "marquee";
    const track = document.createElement("ul");
    track.className = "marquee-track";
    // The second copy only closes the loop, so screen readers hear each partner once.
    for (const duplicate of [false, true]) for (const agent of agents) track.append(partnerCard(agent, duplicate));
    marquee.append(track);
    return marquee;
  }));
}
function partnerCard(agent: SpecialistDefinition, duplicate: boolean): HTMLLIElement {
  const [name, role, intro] = (lang === "en" && PARTNERS_EN[agent.id]) || [agent.nickname, agent.role, agent.intro];
  const card = document.createElement("li");
  card.className = "partner spot";
  if (duplicate) card.setAttribute("aria-hidden", "true");
  const portrait = document.createElement("img");
  portrait.src = PORTRAITS[`./partners/${agent.id}.webp`] ?? "";
  portrait.alt = "";
  portrait.width = portrait.height = 56;
  const title = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = name;
  const small = document.createElement("small");
  small.textContent = role;
  title.append(strong, small);
  const body = document.createElement("p");
  body.textContent = intro;
  card.append(portrait, title, body);
  return card;
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
  const height = Math.min(DEMO_MAX_HEIGHT, Math.max(DEMO_HEIGHT, Math.round(width * 0.6)));
  viewport.style.setProperty("--demo-width", `${Math.max(width, DEMO_MIN_WIDTH)}px`);
  viewport.style.setProperty("--demo-scale", String(scale));
  viewport.style.setProperty("--demo-canvas-height", `${height}px`);
  viewport.style.setProperty("--demo-height", `${Math.round(height * scale)}px`);
}
new ResizeObserver(fitDemo).observe(viewport);

/** With a mouse, resting on a tab selects it; the short wait lets the pointer cross other tabs on its way without flicking through them. */
function selectOnHover(tabs: HTMLElement[], select: (tab: HTMLElement) => void): void {
  let timer: number | undefined;
  for (const tab of tabs) {
    tab.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => select(tab), 120);
    });
    tab.addEventListener("pointerleave", () => window.clearTimeout(timer));
  }
}

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
// All four screenshots sit stacked in the frame, so switching is a crossfade with nothing left to load.
const showcaseTabs = [...document.querySelectorAll<HTMLButtonElement>(".accordion-item")];
const showcaseImage = document.getElementById("showcase-image") as HTMLImageElement;
const showcasePanel = document.getElementById("showcase-panel")!;
const showcaseImages: Record<string, HTMLImageElement> = { chat: showcaseImage };
for (const [key, url] of Object.entries(SHOTS)) {
  if (key === "chat") continue;
  const image = showcaseImage.cloneNode() as HTMLImageElement;
  image.removeAttribute("id");
  image.classList.remove("active");
  image.src = url;
  showcaseImage.parentElement!.append(image);
  showcaseImages[key] = image;
}
function syncShowcaseAlt(): void {
  const selected = showcaseTabs.find(tab => tab.getAttribute("aria-selected") === "true");
  for (const [key, image] of Object.entries(showcaseImages)) {
    image.alt = key === selected?.dataset.key ? selected.querySelector("strong")?.textContent ?? "" : "";
  }
}
function selectShowcase(tab: HTMLElement): void {
  for (const other of showcaseTabs) {
    const active = other === tab;
    other.setAttribute("aria-selected", String(active));
    other.tabIndex = active ? 0 : -1;
  }
  showcasePanel.setAttribute("aria-labelledby", tab.id);
  for (const [key, image] of Object.entries(showcaseImages)) image.classList.toggle("active", key === (tab.dataset.key ?? "chat"));
  syncShowcaseAlt();
}
for (const tab of showcaseTabs) tab.addEventListener("click", () => selectShowcase(tab));
tabKeys(showcaseTabs, selectShowcase);
selectOnHover(showcaseTabs, selectShowcase);

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
selectOnHover(faqTabs, selectFaq);
for (const tab of faqTabs) {
  tab.querySelector(".count")!.textContent = String(document.getElementById(tab.getAttribute("aria-controls")!)!.querySelectorAll("details").length);
}

const copyButton = document.getElementById("copy-sdk") as HTMLButtonElement;
copyButton.addEventListener("click", () => {
  navigator.clipboard.writeText(copyButton.dataset.copy ?? "").then(() => toast(TOAST[lang].copied), () => toast(TOAST[lang].copyFailed));
});

// Clicking the hero avatar makes Firefly hop and say one of her lines, in turn.
const heroAvatar = document.getElementById("hero-avatar")!;
let greeting = 0;
heroAvatar.addEventListener("click", () => {
  toast(GREETINGS[lang][greeting++ % GREETINGS[lang].length]!);
  heroAvatar.classList.remove("hop");
  void heroAvatar.offsetWidth; // restart the hop when clicked again mid-way
  heroAvatar.classList.add("hop");
});
heroAvatar.addEventListener("animationend", () => heroAvatar.classList.remove("hop"));

// Each extend cell repeats its icon, large and faint, in the corner.
for (const icon of document.querySelectorAll<SVGElement>(".link-cell .tile svg")) {
  const watermark = icon.cloneNode(true) as SVGElement;
  watermark.setAttribute("class", "watermark");
  watermark.setAttribute("aria-hidden", "true");
  icon.closest(".link-cell")!.prepend(watermark);
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Fireflies drifting behind the hero and the closing panel, each on its own path and rhythm.
const between = (low: number, high: number) => low + Math.random() * (high - low);
if (!reducedMotion) for (const swarm of document.querySelectorAll<HTMLElement>(".fireflies")) {
  for (let count = swarm.closest(".hero") ? 18 : 10; count > 0; count--) {
    const dot = document.createElement("span");
    const seconds = between(7, 14);
    dot.style.cssText = `--x:${between(2, 98)}%;--y:${between(6, 94)}%;--s:${between(2, 4.5)}px;--d:${seconds}s;`
      + `--delay:${-between(0, seconds)}s;--dx:${between(-40, 40)}px;--dy:${between(-50, 20)}px`;
    swarm.append(dot);
  }
}

// Cards light up where the pointer is (mouse and pen only; touch has no hover).
if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  document.addEventListener("pointermove", (event) => {
    const card = (event.target as Element).closest?.<HTMLElement>(".spot");
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - box.left}px`);
    card.style.setProperty("--my", `${event.clientY - box.top}px`);
  }, { passive: true });
}

// Blocks rise in the first time they scroll into view; afterwards the classes go, so their own hover transitions apply again.
if (!reducedMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.classList.add("in");
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  for (const element of document.querySelectorAll<HTMLElement>(".eyebrow, .section-title, .section-lede, .lead, .partners, .entry, .cells, .accordion, .shot, .closing-panel, .faq")) {
    const siblings = [...element.parentElement!.children].filter(other => other.classList[0] === element.classList[0]);
    element.style.setProperty("--reveal-delay", `${Math.min(siblings.indexOf(element), 4) * 80}ms`);
    element.classList.add("reveal");
    element.addEventListener("transitionend", function done(event) {
      if (event.target !== element || event.propertyName !== "opacity" || !element.classList.contains("in")) return;
      element.classList.remove("reveal", "in");
      element.style.removeProperty("--reveal-delay");
      element.removeEventListener("transitionend", done);
    });
    observer.observe(element);
  }
}

document.getElementById("lang-toggle")!.addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh"; write("ff-site-lang", lang); applyLang();
});
document.getElementById("theme-toggle")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark"; write("ff-site-theme", theme);
  // Where the browser can, the whole page fades from one theme to the other instead of flipping at once.
  if ("startViewTransition" in document && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(applyTheme);
  else applyTheme();
});

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
  if ((event.data as { type?: string } | null)?.type !== "firefly-demo:desktop-only") return;
  toast(TOAST[lang].desktopOnly);
});

applyTheme();
applyLang();
fitDemo();
