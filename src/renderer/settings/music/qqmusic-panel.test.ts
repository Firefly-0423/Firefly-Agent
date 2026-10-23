// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const markup = readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  const page = new DOMParser().parseFromString(markup, "text/html");
  document.body.innerHTML = page.getElementById("music-panel")?.outerHTML || "";
});

afterEach(() => {
  delete (window as unknown as { music?: unknown }).music;
  document.body.innerHTML = "";
});

describe("QQ Music settings panel", () => {
  it("renders actual state and enables only supported controls", async () => {
    (window as unknown as { music: unknown }).music = {
      getStatus: vi.fn(async () => ({ available: true, playbackStatus: "Paused", title: "公开曲目", canPlay: true, canPause: false, canNext: true, canPrev: false })),
      control: vi.fn(),
    };
    const { loadMusicPanel } = await import("./qqmusic-panel");
    loadMusicPanel();
    await flush();
    expect(document.getElementById("qqmusic-track")?.textContent).toContain("公开曲目");
    expect(document.querySelector<HTMLButtonElement>('[data-qqmusic-action="play"]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-qqmusic-action="pause"]')?.disabled).toBe(true);
  });

  it("does not say playback succeeded when command was only accepted", async () => {
    const control = vi.fn(async () => ({ action: "play", target: "QQMusic", commandSubmission: "accepted", playerStateObservation: "unchanged" }));
    (window as unknown as { music: unknown }).music = {
      getStatus: vi.fn(async () => ({ available: true, playbackStatus: "Paused", canPlay: true })),
      control,
    };
    const { loadMusicPanel } = await import("./qqmusic-panel");
    loadMusicPanel();
    await flush();
    document.querySelector<HTMLButtonElement>('[data-qqmusic-action="play"]')?.click();
    await flush();
    expect(control).toHaveBeenCalledOnce();
    expect(document.getElementById("qqmusic-feedback")?.textContent).toContain("unchanged");
    expect(document.getElementById("qqmusic-feedback")?.textContent).not.toContain("播放成功");
  });

  it("keeps unavailable player controls disabled", async () => {
    (window as unknown as { music: unknown }).music = {
      getStatus: vi.fn(async () => ({ available: false, errorCode: "QQ_MUSIC_SESSION_NOT_FOUND" })),
      control: vi.fn(),
    };
    const { loadMusicPanel } = await import("./qqmusic-panel");
    loadMusicPanel();
    await flush();
    expect(document.getElementById("qqmusic-status")?.textContent).toContain("QQ_MUSIC_SESSION_NOT_FOUND");
    expect([...document.querySelectorAll<HTMLButtonElement>("[data-qqmusic-action]")].every((button) => button.disabled)).toBe(true);
  });
});
