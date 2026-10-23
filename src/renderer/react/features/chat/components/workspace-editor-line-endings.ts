/** Textareas normalize all EOLs to LF. Preserve untouched raw prefix/suffix bytes;
 * only the newly inserted span adopts the file's first newline convention. */
export function preserveTextLineEndings(before: string, value: string): string {
  const normalized = before.replace(/\r\n|\r/g, "\n");
  const after = value.replace(/\r\n|\r/g, "\n");
  let prefix = 0;
  while (prefix < normalized.length && prefix < after.length && normalized[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < normalized.length - prefix && suffix < after.length - prefix && normalized[normalized.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const rawOffset = (offset: number) => {
    let raw = 0;
    for (let normalizedIndex = 0; normalizedIndex < offset; normalizedIndex++) {
      raw += before[raw] === "\r" && before[raw + 1] === "\n" ? 2 : 1;
    }
    return raw;
  };
  const inserted = after.slice(prefix, after.length - suffix).replace(/\n/g, before.match(/\r\n|\r|\n/)?.[0] ?? "\n");
  return before.slice(0, rawOffset(prefix)) + inserted + before.slice(rawOffset(normalized.length - suffix));
}
