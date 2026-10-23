import { useEffect, useState } from "react";
import type { ReviewFileChange, ReviewSnapshot } from "../../../../../shared/review-types";
import { workspaceRelativePath } from "./workspace-artifacts";

// A finished run's review snapshot never changes, so every row and tab of that run shares one read.
// Runs without a snapshot yet (still going, or nothing tracked) are not remembered and are asked again next time.
const snapshots = new Map<string, Promise<ReviewSnapshot | null>>();

function readSnapshot(runId: string): Promise<ReviewSnapshot | null> {
  const cached = snapshots.get(runId);
  if (cached) return cached;
  const read = (window.review?.get(runId) ?? Promise.resolve(null)).catch(() => null).then(result => {
    if (!result?.files.length) snapshots.delete(runId);
    return result?.files.length ? result : null;
  });
  snapshots.set(runId, read);
  return read;
}

/** The run's full before/after diff (every line, with line numbers), or null while it is unavailable. */
export function useReviewSnapshot(runId: string | undefined): ReviewSnapshot | null {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!runId) return;
    let live = true;
    void readSnapshot(runId).then(result => { if (live) setSnapshot(result); });
    return () => { live = false; };
  }, [runId]);
  return snapshot;
}

const comparable = (path: string, root?: string) => (workspaceRelativePath(path, root) ?? path.replace(/\\/g, "/")).toLowerCase();

/** The snapshot's record of one file a tool reported, matched by path whether either side is absolute or project-relative. */
export function findReviewFile(snapshot: ReviewSnapshot | null, file: string, workspaceRoot?: string): ReviewFileChange | undefined {
  if (!snapshot) return undefined;
  const wanted = comparable(file, workspaceRoot);
  return snapshot.files.find(item => comparable(item.newPath, workspaceRoot) === wanted)
    ?? snapshot.files.find(item => item.kind === "renamed" && comparable(item.oldPath, workspaceRoot) === wanted);
}
