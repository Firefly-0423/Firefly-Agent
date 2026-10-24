export function rejectZipSymlink(entry: { externalFileAttributes: number }): void {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((mode & 0xf000) === 0xa000) throw new Error("ZIP_SYMLINK_FORBIDDEN");
}
