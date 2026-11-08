export type FilePreview = { id: string; relPath: string; line?: number; lineSeq?: number };

/** Reopening at a line increments a token so an already mounted preview scrolls again. */
export function openFilePreview(tabs: FilePreview[], path: string, line: number | undefined, sequence: () => number): FilePreview[] {
  const id = `file:${path}`;
  if (!tabs.some(tab => tab.id === id)) {
    const tab: FilePreview = { id, relPath: path };
    if (line !== undefined) { tab.line = line; tab.lineSeq = sequence(); }
    return [...tabs, tab];
  }
  return tabs.map(tab => {
    if (tab.id !== id) return tab;
    return { ...tab, line, lineSeq: line === undefined ? undefined : sequence() };
  });
}
