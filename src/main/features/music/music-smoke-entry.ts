import { app } from "electron";
import { bootstrapMusicService } from "./bootstrap";
import { logger, LogTag } from "../../base/logging/logger";

async function main(): Promise<number> {
  await app.whenReady();
  const music = bootstrapMusicService();
  try {
    const state = await music.service.getState();
    logger.info(LogTag.Firefly, `music-smoke: QQ Music status: ${state.available ? "available" : state.errorCode}`);
    return state.available || state.errorCode === "QQ_MUSIC_SESSION_NOT_FOUND" ? 0 : 1;
  } finally {
    await music.shutdown();
  }
}

void main().then((code) => app.exit(code)).catch(() => app.exit(1));
