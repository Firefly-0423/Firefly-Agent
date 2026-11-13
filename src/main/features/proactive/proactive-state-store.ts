// 主动聊天状态的磁盘读写。文件固定为 userData 下的 proactive-state.json，
// 与旧版 opener 的状态文件互不干扰。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { ProactiveState } from "./proactive-types";

const STATE_FILE_NAME = "proactive-state.json";

export function defaultProactiveState(): ProactiveState {
  const fresh = {} as ProactiveState;
  fresh.proactiveEpoch = 0;
  fresh.unansweredCount = 0;
  fresh.lastProactiveAt = null;
  fresh.lastProactiveScene = null;
  fresh.lastNormalConversationEndedAt = null;
  fresh.globalDesire = 0;
  fresh.affinity = {};
  fresh.lastFiredAt = {};
  return fresh;
}

function statePathOnDisk(): string {
  return path.join(app.getPath("userData"), STATE_FILE_NAME);
}

export function loadProactiveState(): ProactiveState {
  try {
    const location = statePathOnDisk();
    if (!fs.existsSync(location)) return defaultProactiveState();
    const stored = JSON.parse(fs.readFileSync(location, "utf8")) as Partial<ProactiveState>;
    const defaults = defaultProactiveState();
    const merged: ProactiveState = { ...defaults, ...stored };
    merged.affinity = { ...defaults.affinity, ...(stored.affinity ?? {}) };
    merged.lastFiredAt = { ...(stored.lastFiredAt ?? {}) };
    return merged;
  } catch {
    return defaultProactiveState();
  }
}

export function saveProactiveState(state: ProactiveState): void {
  try {
    fs.writeFileSync(statePathOnDisk(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[Proactive] save state failed:", err);
  }
}
