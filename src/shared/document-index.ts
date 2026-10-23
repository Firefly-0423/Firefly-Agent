export type DocumentIndexJobStatus = "queued" | "reading" | "chunking" | "embedding"
  | "cached" | "done" | "failed" | "cancelled";
export type DocumentIndexProgress = {
  reason?: string;
  totalChunks?: number;
  completedChunks?: number;
  status: DocumentIndexJobStatus;
  fileName: string;
  filePath: string;
  jobId: string;
};
