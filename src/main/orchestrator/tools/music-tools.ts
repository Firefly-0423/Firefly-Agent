import type { QqMusicService } from "../../music/qqmusic-service";
import type { ToolDefinition } from "./registry/tool-registry";

/** 音乐工具开关控制的全部工具 id。 */
export const MUSIC_TOOL_IDS = ["music_get_playback_status", "music_control"] as const;

export function buildMusicTools(service: QqMusicService): ToolDefinition[] {
  return [
    {
      id: "music_get_playback_status",
      capability: "music.playback_status",
      name: "读取 QQ Music 状态",
      description: "只读取官方 QQ Music 桌面客户端当前曲目、播放状态和进度；未检测到 QQMusic.exe 会话时明确返回不可用。",
      enabled: true,
      modes: ["chat", "work"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      effectKind: "read",
      verificationPolicy: "none",
      execute: async (_args, context) => JSON.stringify(await service.getState(context?.signal)),
    },
    {
      id: "music_control",
      capability: "music.control",
      name: "控制 QQ Music 播放",
      description: "只控制官方 QQ Music 桌面客户端。返回命令是否被接收及随后一次状态读取是否观察到变化；接收不等于播放成功。",
      enabled: true,
      modes: ["chat", "work"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["play", "pause", "toggle", "next", "previous"] } },
        required: ["action"],
      },
      needsContext: true,
      effectKind: "external_side_effect",
      verificationPolicy: "none",
      execute: async (args, context) => {
        const action = args.action;
        if (action !== "play" && action !== "pause" && action !== "toggle" && action !== "next" && action !== "previous") {
          throw new Error("QQ_MUSIC_INVALID_ACTION");
        }
        return JSON.stringify(await service.control(action, context?.signal));
      },
    },
  ];
}
