import { useCallback, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "../../../i18n";

interface CopyButtonProps { text: string; size?: number; color?: string }

function copyUsingSelection(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  document.body.appendChild(field);
  field.select();
  let success = false;
  try { success = document.execCommand("copy"); }
  catch { success = false; }
  document.body.removeChild(field);
  return success;
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  return copyUsingSelection(value);
}

function CopyGlyph({ size, color, copied }: { size: number; color: string; copied: boolean }) {
  const motion: CSSProperties = { position: "absolute", transition: "opacity 0.2s ease, transform 0.2s ease" };
  return <>
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 48 48" height={size} width={size}
      style={{ ...motion, opacity: copied ? 0 : 1, transform: copied ? "scale(0.85)" : "scale(1)" }}>
      <path strokeLinejoin="round" strokeLinecap="round" strokeWidth="4" stroke={color}
        d="M13 12.4316V7.8125C13 6.2592 14.2592 5 15.8125 5H40.1875C41.7408 5 43 6.2592 43 7.8125V32.1875C43 33.7408 41.7408 35 40.1875 35H35.5163" />
      <path strokeLinejoin="round" strokeWidth="4" stroke={color} fill="none"
        d="M32.1875 13H7.8125C6.2592 13 5 14.2592 5 15.8125V40.1875C5 41.7408 6.2592 43 7.8125 43H32.1875C33.7408 43 35 41.7408 35 40.1875V15.8125C35 14.2592 33.7408 13 32.1875 13Z" />
    </svg>
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 48 48" height={size} width={size}
      style={{ ...motion, opacity: copied ? 1 : 0, transform: copied ? "scale(1)" : "scale(1.15)" }}>
      <path strokeLinejoin="round" strokeLinecap="round" strokeWidth="4" stroke="#52c41a" d="M10 24L20 34L40 14" />
    </svg>
  </>;
}

export function CopyButton({ text, size = 16, color = "#8e8e93" }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copyConfirmed, showCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback(async () => {
    if (!text.trim()) return;
    const success = await copyTextToClipboard(text);
    if (!success) return;
    showCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => showCopied(false), 1200);
  }, [text]);
  return <button style={{ position: "relative", width: size, height: size, border: "none", background: "none",
    cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
    title={t("common.copy")} aria-label={t("common.copy")} onClick={copy} className="ff-copy-button" type="button">
    <CopyGlyph copied={copyConfirmed} color={color} size={size} />
  </button>;
}
