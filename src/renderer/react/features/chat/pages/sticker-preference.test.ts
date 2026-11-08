import { describe, expect, it, vi } from "vitest";
import { observeStickerPreference } from "./sticker-preference";

describe("sticker preference", () => {
  it("loads the preference, handles updates, and unsubscribes", async () => {
    let notify: (value: { stickerSize?: "small" | "large" }) => void = () => {};
    const off = vi.fn();
    const set = vi.fn();
    const stop = observeStickerPreference({
      get: async () => ({ stickerSize: "small" }),
      onChanged: listener => { notify = listener; return off; },
    }, set);
    await Promise.resolve();
    notify({ stickerSize: "large" });
    notify({});
    expect(set.mock.calls).toEqual([["small"], ["large"], ["standard"]]);
    stop();
    notify({ stickerSize: "small" });
    expect(off).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("falls back on a failed read and ignores a late read after cleanup", async () => {
    const set = vi.fn();
    const off = vi.fn();
    const stop = observeStickerPreference({ get: () => Promise.reject(new Error("offline")), onChanged: () => off }, set);
    await Promise.resolve(); await Promise.resolve();
    expect(set).toHaveBeenCalledWith("standard");
    stop();
    let resolve!: (config: {}) => void;
    const later = observeStickerPreference({ get: () => new Promise(r => { resolve = r; }), onChanged: () => off }, set);
    later(); resolve({}); await Promise.resolve();
    expect(set).toHaveBeenCalledTimes(1);
  });
});
