// 保留旧启动与浏览器回包的兼容反馈。
type PlaybackState = "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed";
interface PlaybackIpcResult {
  ok: boolean; data?: { state: PlaybackState }; errorCode?: string;
}

export async function requestTrackPlayback(
  api: { playTrack: (trackId: string) => Promise<PlaybackIpcResult> }, track: { id: string; name: string },
): Promise<{ kind: "ok" | "err"; message: string }> {
  const response = await api.playTrack(track.id);
  if (!response.ok) {
    return { kind: "err", message: `播放请求失败：${response.errorCode ?? "E_UNKNOWN"}` };
  }
  switch (response.data?.state) {
    case "dispatched":
      return { kind: "ok", message: `已开始播放：${track.name}` };
    case "client_unavailable":
      return { kind: "err", message: `已找到《${track.name}》，但 mpv 播放器未就绪。请重启应用，或确认 resources/bin/mpv/mpv.exe 存在。` };
    case "launch_failed":
      return { kind: "err", message: `mpv 启动失败，无法播放《${track.name}》。` };
    case "web_fallback":
      return { kind: "ok", message: `已在浏览器中打开：${track.name}` };
    default:
      return { kind: "err", message: `未能播放《${track.name}》：${response.data?.state ?? "unknown"}` };
  }
}
