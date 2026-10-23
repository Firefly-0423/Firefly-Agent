export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  const segments: string[] = [];
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    segments.push(String.fromCharCode(...view.subarray(offset, offset + 0x8000)));
  }
  return btoa(segments.join(""));
}

export function containsFiles(dataTransfer: Pick<DataTransfer, "types">): boolean {
  const formats = Array.from(dataTransfer.types);
  return formats.includes("Files");
}
