import { useState } from "react";

export function StickerImage({ src, unavailable, alt, className }: { src?: string; unavailable?: string; alt: string; className?: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  const message = unavailable ?? (src && failedSource === src ? "表情包不可用" : undefined);
  if (message) return <span role="status" className="sticker-unavailable">{message}</span>;
  if (!src) return null;
  return <img src={src} alt={alt} className={className} draggable={false} onError={() => setFailedSource(src)} />;
}
