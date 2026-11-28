// ── 音乐工具路由 ──────────────────────────────────────────────
/** Navigates to the music detail panel when clicking the QQ Music platform entry. */
export function initMusicShortcut(navigateToMusic: () => void): void {
  document.getElementById("music-platform-qq")?.addEventListener("click", () => {
    navigateToMusic();
  });
}
