import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileDiff } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { ReviewFileChange, ReviewRestoreOutcome, ReviewSnapshot } from "../../../../../shared/review-types";
import "./ReviewPanel.css";

const KIND_LABEL_KEYS: Record<ReviewFileChange["kind"], string> = {
  modified: "review.kindModified", created: "review.kindCreated", deleted: "review.kindDeleted",
  renamed: "review.kindRenamed", binary: "review.kindBinary", "large-text": "review.kindLargeText",
};
const KIND_CLASS: Record<ReviewFileChange["kind"], string> = {
  modified: "is-modified", created: "is-created", deleted: "is-deleted",
  renamed: "is-renamed", binary: "is-binary", "large-text": "is-large",
};

function splitPath(filePath: string): { dir: string; base: string } {
  const boundary = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return boundary < 0 ? { dir: "", base: filePath }
    : { dir: filePath.slice(0, boundary + 1), base: filePath.slice(boundary + 1) };
}

type ReviewPanelProps = {
  runId: string;
  onOpenInspector?: (runId: string, fileIndex: number, filePath: string) => void;
};

export function ReviewPanel({ runId, onOpenInspector }: ReviewPanelProps) {
  const { t } = useTranslation();
  const [reviewData, setReviewData] = useState<ReviewSnapshot | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [restoreArmed, setRestoreArmed] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] = useState<ReviewRestoreOutcome | null>(null);

  async function handleRestoreClick(): Promise<void> {
    if (restoreBusy) return;
    if (!restoreArmed) {
      setRestoreArmed(true);
      return;
    }
    setRestoreBusy(true);
    try {
      const outcome = await window.review?.restore(runId);
      const unavailable: ReviewRestoreOutcome = {
        ok: false, restored: 0, skipped: [], failed: [], error: "review API 不可用",
      };
      setRestoreResult(outcome ?? unavailable);
    } catch (error) {
      setRestoreResult({
        ok: false, restored: 0, skipped: [], failed: [],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestoreBusy(false);
      setRestoreArmed(false);
    }
  }

  const restoreSummary = useMemo(() => {
    const outcome = restoreResult;
    if (!outcome) return null;
    if (outcome.error) return t("review.restoreFailed", { reason: outcome.error });
    if (outcome.failed.length === 0 && outcome.skipped.length === 0) {
      return t("review.restoreDone", { count: outcome.restored });
    }
    return t("review.restorePartial", {
      restored: outcome.restored, skipped: outcome.skipped.length, failed: outcome.failed.length,
    });
  }, [restoreResult, t]);

  useEffect(function loadReviewWithRetries() {
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;
    async function fetchData() {
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
      retryCount++;
      if (retryCount < MAX_RETRIES && !cancelled) setTimeout(() => void fetchData(), RETRY_DELAY);
    }
    void fetchData();
    return () => { cancelled = true; };
  }, [runId]);
  const addedLines = useMemo(() => reviewData?.files.reduce((total, file) => total + file.additions, 0) ?? 0, [reviewData]);
  const removedLines = useMemo(() => reviewData?.files.reduce((total, file) => total + file.deletions, 0) ?? 0, [reviewData]);
  if (!reviewData) return null;

  const fileRows = reviewData.files.map((file, index) => {
    const { dir, base } = splitPath(file.newPath);
    return <button title={file.newPath} onClick={() => onOpenInspector?.(runId, index, file.newPath)}
      className="ff-review-panel__file-item" type="button" key={`${file.kind}:${file.oldPath}:${file.newPath}:${index}`}>
      <span className={`ff-review-panel__kind ${KIND_CLASS[file.kind]}`}>{t(KIND_LABEL_KEYS[file.kind])}</span>
      <span className="ff-review-panel__base">
        {base}
      </span>
      {dir && <span className="ff-review-panel__dir">{dir}</span>}
      <ReviewStatistics className="ff-review-panel__file-stats" additions={file.additions} deletions={file.deletions} />
      <svg aria-hidden="true" viewBox="0 0 16 16" className="ff-review-panel__arrow">
        <path strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" stroke="currentColor" fill="none" d="m6 4 4 4-4 4" />
      </svg>
    </button>;
  });
  return <section aria-label={t("review.panelAria")} className={`ff-review-panel${detailsOpen ? " is-expanded" : ""}`}>
    <button aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)} className="ff-review-panel__header" type="button">
      <FileDiff aria-hidden="true" size={15} className="ff-review-panel__lead" />
      <span className="ff-review-panel__title">{t("review.fileCount", { count: reviewData.files.length })}</span>
      <ReviewStatistics className="ff-review-panel__stats" additions={addedLines} deletions={removedLines} />
      <ChevronRight aria-hidden="true" size={14} className="ff-review-panel__chevron" />
    </button>
    <div inert={!detailsOpen} className="ff-review-panel__body"><div className="ff-review-panel__list">
      {fileRows}
      <div className="ff-review-panel__restore">
        {restoreSummary ? <span className={`ff-review-panel__restore-summary${restoreResult?.ok === false ? " is-error" : ""}`}>{restoreSummary}</span>
          : <button disabled={restoreBusy} onClick={() => void handleRestoreClick()}
            className={`ff-review-panel__restore-btn${restoreArmed ? " is-confirming" : ""}`} type="button">
            {restoreBusy ? t("review.restoreRunning") : restoreArmed ? t("review.restoreConfirm") : t("review.restoreButton")}
          </button>}
      </div>
    </div></div>
  </section>;
}

function ReviewStatistics({ className, additions, deletions }: { className: string; additions: number; deletions: number }) {
  return <span className={className}>
    {additions > 0 && <span className="is-add">+{additions}</span>}
    {deletions > 0 && <span className="is-remove">−{deletions}</span>}
  </span>;
}
