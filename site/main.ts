// 宣传页脚本：中英切换、深浅色、横幅随两者切换，以及演示页传来的"桌面版功能"提示。
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";
import bannerLight from "./banner/firefly-banner-light.gif";
import bannerDark from "./banner/firefly-banner-dark.gif";
import bannerLightEn from "./banner/firefly-banner-light.en.gif";
import bannerDarkEn from "./banner/firefly-banner-dark.en.gif";

type Lang = "zh" | "en";
type Theme = "light" | "dark";

const EN: Record<string, string> = {
  "nav.demo": "Try it", "nav.features": "Features", "nav.download": "Download", "nav.github": "GitHub", "nav.theme": "Toggle theme",
  "hero.bannerAlt": "Firefly-Agent: a Firefly desktop companion and AI workbench",
  "hero.title": "Someone to talk to, and to get things done with",
  "hero.lede": "Firefly puts a desktop character who chats with you and an agent workbench that does real work in one window. You see every step it takes and everything it needs you to approve.",
  "hero.try": "Try it online", "hero.download": "Download for Windows",
  "demo.eyebrow": "The real desktop UI", "demo.title": "Try Firefly right here",
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
  "download.eyebrow": "Download", "download.title": "Windows desktop app",
  "download.body": "Needs Windows 10 / 11 (x64). The installer includes no model service or account; add your own model service in settings after the first launch.",
  "download.installer": "Go to GitHub Releases", "download.source": "View the source", "download.issues": "Report an issue",
  "footer.license": "The source code is MIT licensed; third-party dependencies, models, images and character assets follow their own licenses.",
  "footer.ip": "Firefly and Honkai: Star Rail characters and IP belong to HoYoverse / miHoYo and the respective rights holders. This is an unofficial, non-commercial fan project; derivatives containing the Firefly character or character art may not be used commercially.",
  "footer.notices": "Third-party and asset notices", "footer.siteLicenses": "Open-source licenses in this page",
  "footer.demoLicenses": "Open-source licenses in the online demo",
  "toast.desktopOnly": "That part needs the desktop app.",
};
const ZH_TOAST = "这个功能需要在桌面版里使用。";

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
