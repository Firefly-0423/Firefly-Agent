import elioUrl from "../assets/task-portraits/艾利欧.png";
import hertaUrl from "../assets/task-portraits/大黑塔.png";
import danhengUrl from "../assets/task-portraits/丹恒.png";
import himekoUrl from "../assets/task-portraits/姬子.png";
import kafkaUrl from "../assets/task-portraits/卡芙卡.png";
import pompomUrl from "../assets/task-portraits/帕姆.png";
import bladeUrl from "../assets/task-portraits/刃.png";
import marchUrl from "../assets/task-portraits/三月七.png";
import weltUrl from "../assets/task-portraits/瓦尔特.png";
import sundayUrl from "../assets/task-portraits/星期日.png";
import silverWolfUrl from "../assets/task-portraits/银狼.png";
import robinUrl from "../assets/task-portraits/知更鸟.png";

const portraitByAssetFileName: Readonly<Record<string, string>> = {
  "艾利欧.png": elioUrl,
  "大黑塔.png": hertaUrl,
  "丹恒.png": danhengUrl,
  "姬子.png": himekoUrl,
  "卡芙卡.png": kafkaUrl,
  "帕姆.png": pompomUrl,
  "刃.png": bladeUrl,
  "三月七.png": marchUrl,
  "瓦尔特.png": weltUrl,
  "星期日.png": sundayUrl,
  "银狼.png": silverWolfUrl,
  "知更鸟.png": robinUrl,
};

export function getCharacterPortraitByAssetFileName(assetFileName: string): string | null {
  return portraitByAssetFileName[assetFileName] ?? null;
}
