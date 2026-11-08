import type { ModelConfigApi, PublicModelConfig } from "./chat-page-bridge";

type StickerSize = "small" | "standard" | "large";

/** Connect the initial read and later changes to the page's sticker-size state. */
export function observeStickerPreference(api: ModelConfigApi, publish: (size: StickerSize) => void): () => void {
  let listening = true;
  const receive = (config: PublicModelConfig) => {
    if (!listening) return;
    const size = config.stickerSize;
    publish(size === "small" || size === "large" ? size : "standard");
  };
  void api.get().then(receive).catch(() => {
    if (listening) publish("standard");
  });
  const unsubscribe = api.onChanged(receive);
  return () => {
    listening = false;
    unsubscribe();
  };
}
