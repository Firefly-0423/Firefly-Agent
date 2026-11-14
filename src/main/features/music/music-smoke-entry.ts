import { app } from "electron";
import { bootstrapMusicService } from "./bootstrap";

async function main(): Promise<number> {
  await app.whenReady();
  const music = bootstrapMusicService();
  try {
    const state = await music.service.getState();
    console.log(`[music-smoke] QQ Music status: ${state.available ? "available" : state.errorCode}`);
    return state.available || state.errorCode === "QQ_MUSIC_SESSION_NOT_FOUND" ? 0 : 1;
  } finally {
    await music.shutdown();
  }
}

void main().then((code) => app.exit(code)).catch(() => app.exit(1));
