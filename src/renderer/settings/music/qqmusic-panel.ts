import type { QqMusicAction, QqMusicControlResult, QqMusicState } from "../../../main/music/qqmusic-service";

interface QqMusicApi {
  getStatus(): Promise<QqMusicState>;
  control(action: QqMusicAction): Promise<QqMusicControlResult>;
}

function musicApi(): QqMusicApi | null {
  return (window as unknown as { music?: QqMusicApi }).music ?? null;
}

let generation = 0;
let bound = false;
let busy = false;

function setFeedback(message: string, error = false): void {
  const element = document.getElementById("qqmusic-feedback");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("music-feedback--err", error);
}

function renderState(state: QqMusicState): void {
  const status = document.getElementById("qqmusic-status");
  const track = document.getElementById("qqmusic-track");
  if (status) status.textContent = state.available ? `QQ Music：${state.playbackStatus}` : `QQ Music 不可用：${state.errorCode}`;
  if (track) track.textContent = state.available
    ? [state.title, state.artist, state.albumTitle].filter(Boolean).join(" · ")
    : "请先启动 QQ Music 桌面客户端。";
  document.getElementById("music-status-dot")?.classList.toggle("is-connected", state.available);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-qqmusic-action]")) {
    const action = button.dataset.qqmusicAction;
    button.disabled = busy || !state.available || (
      action === "play" ? !state.canPlay
        : action === "pause" ? !state.canPause
          : action === "next" ? !state.canNext : !state.canPrev
    );
  }
}

async function refresh(requestGeneration: number): Promise<void> {
  const api = musicApi();
  if (!api) {
    setFeedback("QQ Music 控制接口未就绪", true);
    return;
  }
  try {
    const state = await api.getStatus();
    if (requestGeneration === generation) renderState(state);
  } catch {
    if (requestGeneration === generation) {
      renderState({ available: false, errorCode: "QQ_MUSIC_STATUS_FAILED" });
      setFeedback("读取 QQ Music 状态失败", true);
    }
  }
}

export function loadMusicPanel(): void {
  const requestGeneration = ++generation;
  if (!bound) {
    bound = true;
    document.getElementById("qqmusic-refresh")?.addEventListener("click", () => void refresh(generation));
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-qqmusic-action]")) {
      button.addEventListener("click", async () => {
        if (busy) return;
        const action = button.dataset.qqmusicAction;
        if (action !== "play" && action !== "pause" && action !== "next" && action !== "previous") return;
        const api = musicApi();
        if (!api) { setFeedback("QQ Music 控制接口未就绪", true); return; }
        busy = true;
        button.disabled = true;
        const controlGeneration = generation;
        try {
          const result = await api.control(action);
          if (controlGeneration !== generation) return;
          const submitted = result.commandSubmission === "accepted";
          setFeedback(submitted
            ? `命令已提交；状态观察：${result.playerStateObservation}${result.errorCode ? `（${result.errorCode}）` : ""}`
            : `命令未执行：${result.errorCode || result.commandSubmission}`, !submitted || result.playerStateObservation === "failed");
          if (result.observedState) renderState(result.observedState);
        } catch {
          if (controlGeneration === generation) setFeedback("QQ Music 控制请求失败", true);
        } finally {
          busy = false;
          if (controlGeneration === generation) void refresh(generation);
        }
      });
    }
  }
  void refresh(requestGeneration);
}

export function disposeMusicPanel(): void {
  generation += 1;
}
