// 只识别历史引用，不重新提供这些资源。
const RETIRED_BY_EXTENSION = {
  png: ["playful", "love-happy", "confident", "serious", "calm", "love-calm"],
  gif: ["peek", "clingy-confused"],
  jpg: ["HI", "hello", "goodmoring1", "goodnight", "teatime", "eating", "Allset", "OK", "copythat", "Thumbsup", "awesome", "sogood", "sonice", "fighting", "hellyeah", "Thanks", "foryou", "blushhard", "shyshort", "hmph", "hugtight", "Airkiss", "Gigglelots", "thinking", "putmd", "Whatswrong", "midmeh", "awkward", "Madnow", "Hurtcry", "Sobbinghard", "weeploud", "PanincCrying", "missme", "Free", "Dreak", "outfast", "Vcayover", "sleepynow", "deadtired", "sotired", "giveup", "poorwallet", "please"],
} as const;

const retiredIds: Record<string, true> = {};
const retiredPaths = new Set<string>();
for (const [extension, ids] of Object.entries(RETIRED_BY_EXTENSION)) {
  for (const id of ids) {
    retiredIds[id] = true;
    retiredPaths.add(`stickers/${id}.${extension}`);
  }
}

export function isRetiredStickerId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(retiredIds, id);
}

export function isRetiredStickerRef(ref: string): boolean {
  return retiredPaths.has(ref.startsWith("/") ? ref.slice(1) : ref);
}
