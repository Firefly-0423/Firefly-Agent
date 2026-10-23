export function extractMessageStickerId(content: string, explicitSticker?: string | null): string | undefined {
  if (explicitSticker) return explicitSticker;
  const marker = /\[sticker:([^\]]+)\]/i.exec(content);
  const identifier = marker?.[1]?.trim();
  return identifier || undefined;
}

export function stripMessageStickerMarkers(content: string): string {
  const visible = content.replace(/\[sticker:[^\]]+\]/gi, "");
  return visible.trim();
}
