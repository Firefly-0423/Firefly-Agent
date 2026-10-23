import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { ReviewFileChange, ReviewSnapshot } from "../../../../../shared/review-types";
import { CodeDiff } from "../workspace/CodeDiff";
import "./ReviewInspector.css";

const KIND_LABEL_KEYS: Record<ReviewFileChange["kind"], string> = {
  modified: "review.kindModified", created: "review.kindCreated", deleted: "review.kindDeleted",
  renamed: "review.kindRenamed", binary: "review.kindBinary", "large-text": "review.kindLargeText",
};
const KIND_CLASS: Record<ReviewFileChange["kind"], string> = {
  modified: "is-modified", created: "is-created", deleted: "is-deleted",
  renamed: "is-renamed", binary: "is-binary", "large-text": "is-large",
};

export function ReviewDiffContent({ runId, fileIndex }: { runId: string; fileIndex: number }) {
  const { t } = useTranslation();
  const [reviewData, setReviewData] = useState<ReviewSnapshot | null>(null);
  useEffect(function fetchReviewSnapshot() {
    let cancelled = false;
    async function load() {
      if (cancelled) return;
      try {
        const next = await window.review?.get(runId);
        if (cancelled) return;
        if (next && next.files.length > 0) {
          setReviewData(next);
          return;
        }
      } catch {
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [runId]);
  const selectedFile = reviewData?.files[fileIndex];
  return <div className="ff-review-diff-content">
    <div title={selectedFile?.newPath ?? ""} className="ff-review-inspector__file-title">
      {selectedFile && <span className={`ff-review-inspector__kind ${KIND_CLASS[selectedFile.kind]}`}>{t(KIND_LABEL_KEYS[selectedFile.kind])}</span>}
      <span className="ff-review-inspector__title-text">
        {selectedFile?.newPath ?? t("common.loading")}
      </span>
    </div>
    <div className="ff-review-inspector__body">
      {!selectedFile && <div className="ff-review-inspector__loading">{t("common.loading")}</div>}
      {selectedFile && <DiffView file={selectedFile} />}
    </div>
  </div>;
}

function DiffView({ file }: { file: ReviewFileChange }) {
  const { t } = useTranslation();
  if (file.kind === "binary" || file.kind === "large-text") {
    const sizes = <>
      {file.before && <span className="ff-review-inspector__meta-size">
        {formatSize(file.before.size)}{file.after ? ` → ${formatSize(file.after.size)}` : ""}
      </span>}
      {!file.before && file.after && <span className="ff-review-inspector__meta-size">{formatSize(file.after.size)}</span>}
    </>;
    return <div className="ff-review-inspector__meta">
      <div className="ff-review-inspector__meta-info">
        <span className={`ff-review-inspector__kind ${KIND_CLASS[file.kind]}`}>{t(KIND_LABEL_KEYS[file.kind])}</span>{sizes}
      </div>
      <div className="ff-review-inspector__meta-hint">{file.kind === "binary" ? t("review.binaryHint") : t("review.largeTextHint")}</div>
    </div>;
  }
  if (!file.hunks || file.hunks.length === 0) {
    const hint = file.kind === "renamed" ? t("review.renamedHint") : t("review.noDiffHint");
    return <div className="ff-review-inspector__meta"><div className="ff-review-inspector__meta-hint">{hint}</div></div>;
  }
  return <div className="ff-review-inspector__diff-content"><CodeDiff hunks={file.hunks} /></div>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (bytes < 1024 * 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
