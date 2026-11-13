import path from "node:path";

/** Extensions that can run code or change the system when opened. They can still be saved and shown in their
 * folder, but the window never offers to open them. */
const RISKY_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl", "msc", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "hta", "lnk", "url", "reg", "dll", "sys", "jar", "jnlp", "appx", "msix", "application", "gadget", "inf", "scf", "chm", "iso", "img", "vhd",
  "apk", "app", "dmg", "pkg", "command", "sh", "bash", "run", "bin", "py", "pyw", "rb", "pl",
]);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_DOWNLOAD_FILE_NAME = 120;

/** A file name safe to create inside a chosen folder: no path parts, control or reserved characters,
 * no trailing dots or spaces, no reserved Windows device names, bounded length. */
export function sanitizeDownloadFileName(raw: unknown, fallback = "download"): string {
  let name = typeof raw === "string" ? raw : "";
  name = name.normalize("NFC").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (!name) name = fallback;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : "";
  const safeBase = RESERVED_WINDOWS_NAMES.test(base) ? `_${base}` : base;
  const trimmedExtension = extension.slice(0, 16);
  const room = Math.max(1, MAX_DOWNLOAD_FILE_NAME - trimmedExtension.length);
  return `${[...safeBase].slice(0, room).join("")}${trimmedExtension}`;
}

/** True when the file type can run code, judged by every extension in the name (`a.pdf.exe` is risky). */
export function isRiskyDownloadName(name: string): boolean {
  const parts = name.toLowerCase().split(".").slice(1);
  return parts.some(part => RISKY_EXTENSIONS.has(part.trim()));
}

/** `name`, `name (1)`, `name (2)` ... the first that does not exist in the folder. */
export function uniqueDownloadPath(directory: string, name: string, exists: (candidate: string) => boolean): string {
  const extension = path.extname(name), base = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 1000; index++) {
    const candidate = path.join(directory, index === 0 ? name : `${base} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error("no free download name");
}

/** Only plain HTTPS downloads from a public-looking host: no credentials, blob/data/file/http. */
export function downloadHost(urlChain: readonly string[]): string | null {
  if (!urlChain.length || urlChain.length > 20) return null;
  let host: string | null = null;
  for (const raw of urlChain) {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    host = url.hostname;
  }
  return host;
}
