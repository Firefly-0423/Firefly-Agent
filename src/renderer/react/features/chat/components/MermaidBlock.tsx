import { useMemo, useState } from "react";
import { renderMermaidSVG } from "beautiful-mermaid";
import { useTranslation } from "../../../i18n";
import { isOverSourceLimit, sanitizeSvg, stripFontImports } from "./svg-sanitize";
import { SvgPreviewModal } from "./SvgPreviewModal";

const FIREFLY_THEME = {
  bg: "var(--ff-diagram-bg)", fg: "var(--ff-diagram-fg)", line: "var(--ff-diagram-line)",
  accent: "var(--ff-diagram-accent)", muted: "var(--ff-diagram-muted)", surface: "var(--ff-diagram-node)",
  border: "var(--ff-diagram-node-border)", transparent: true,
};
type MermaidResult = { kind: "svg"; svg: string } | { kind: "fuse" } | { kind: "error" };

export function renderMermaidSafe(code: string): MermaidResult {
  if (isOverSourceLimit(code)) return { kind: "fuse" };
  try {
    const rendered = renderMermaidSVG(code, FIREFLY_THEME);
    const cleaned = stripFontImports(rendered);
    const svg = sanitizeSvg(cleaned);
    return svg ? { kind: "svg", svg } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export function MermaidBlock({ code, streaming }: { code: string; streaming?: boolean }) {
  const { t } = useTranslation();
  const [previewVisible, showZoom] = useState(false);
  const diagram = useMemo(() => {
    return streaming ? null : renderMermaidSafe(code);
  }, [code, streaming]);
  let view;
  if (streaming || diagram === null) {
    view = <div className="ff-mermaid ff-mermaid--pending">{t("messageList.mermaidPending")}</div>;
  } else if (diagram.kind !== "svg") {
    view = <div className="ff-mermaid ff-mermaid--fallback">
      <div className="ff-mermaid__hint">{t("messageList.mermaidFallback")}</div><pre className="ff-mermaid__source">{code}</pre>
    </div>;
  } else {
    view = <>
      <div dangerouslySetInnerHTML={{ __html: diagram.svg }} onClick={() => showZoom(true)}
        title={t("messageList.diagramZoomHint")} className="ff-mermaid ff-mermaid--zoomable" />
      <SvgPreviewModal onClose={() => showZoom(false)} open={previewVisible} svg={diagram.svg} />
    </>;
  }
  return view;
}
