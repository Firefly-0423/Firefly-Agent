import { useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import { isOverHandwrittenSvgLimit, sanitizeSvg, stripFontImports } from "./svg-sanitize";
import { SvgPreviewModal } from "./SvgPreviewModal";

type SvgCardResult = { kind: "svg"; svg: string } | { kind: "fuse" } | { kind: "error" };
export function renderSvgCardSafe(code: string): SvgCardResult {
  if (isOverHandwrittenSvgLimit(code)) return { kind: "fuse" };
  const trimmed = code.trim();
  const localFonts = stripFontImports(trimmed);
  const svg = sanitizeSvg(localFonts);
  return !svg || !svg.includes("<svg") ? { kind: "error" } : { kind: "svg", svg };
}

export function SvgCardBlock({ code, streaming }: { code: string; streaming?: boolean }) {
  const { t } = useTranslation();
  const [previewVisible, setZoomed] = useState(false);
  const cardResult = useMemo(() => {
    return streaming ? null : renderSvgCardSafe(code);
  }, [code, streaming]);
  let view;
  if (streaming || cardResult === null) {
    view = <div className="ff-svg-card ff-svg-card--pending">{t("messageList.svgCardPending")}</div>;
  } else if (cardResult.kind !== "svg") {
    view = <div className="ff-svg-card ff-svg-card--fallback">
      <div className="ff-svg-card__hint">{t("messageList.svgCardFallback")}</div><pre className="ff-svg-card__source">{code}</pre>
    </div>;
  } else {
    view = <>
      <div dangerouslySetInnerHTML={{ __html: cardResult.svg }} onClick={() => setZoomed(true)}
        title={t("messageList.diagramZoomHint")} className="ff-svg-card ff-svg-card--zoomable" />
      <SvgPreviewModal onClose={() => setZoomed(false)} open={previewVisible} svg={cardResult.svg} />
    </>;
  }
  return view;
}
