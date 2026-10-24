// 各输入框共享保存计时器，初次加载时均未安排任务。
type SaveDelay = ReturnType<typeof setTimeout> | undefined;
interface PluginSaveDelays {
  amapKeyDebounceTimer: SaveDelay; travelAmapKeyDebounceTimer: SaveDelay;
  emailSmtpHostTimer: SaveDelay; emailSmtpPortTimer: SaveDelay;
  emailSmtpUserTimer: SaveDelay; emailSmtpPassTimer: SaveDelay;
  emailFromNameTimer: SaveDelay;
}

export const pluginsState: PluginSaveDelays = {
  amapKeyDebounceTimer: undefined, travelAmapKeyDebounceTimer: undefined,
  emailSmtpHostTimer: undefined, emailSmtpPortTimer: undefined,
  emailSmtpUserTimer: undefined, emailSmtpPassTimer: undefined,
  emailFromNameTimer: undefined,
};
