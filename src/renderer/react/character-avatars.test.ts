import { describe, expect, it } from "vitest";
import { TASK_CHARACTERS } from "../../shared/task-characters";
import { getCharacterPortraitByAssetFileName } from "./character-portraits";
import { getCharacterAvatar } from "./character-avatars";

describe("Shared character avatars", () => {
  it("resolves only the current Kafka portrait filename", () => {
    expect(getCharacterPortraitByAssetFileName("卡夫卡.png")).toBeNull();
    expect(getCharacterPortraitByAssetFileName("卡芙卡.png")).toBeTruthy();
    expect(TASK_CHARACTERS.find(character => character.nickname === "卡芙卡")?.assetFileName).toBe("卡芙卡.png");
  });
  it("uses the confirmed task portrait for every current character", () => {
    for (const character of TASK_CHARACTERS) {
      expect(getCharacterAvatar(character.nickname)).not.toBeNull();
      expect(getCharacterAvatar(character.nickname)).toBe(getCharacterPortraitByAssetFileName(character.assetFileName));
    }
  });

  it("does not display a retired or misspelled character portrait", () => {
    expect(getCharacterAvatar("未登记角色")).toBeNull();
    expect(getCharacterAvatar("风堇")).toBeNull();
    expect(getCharacterAvatar("卡夫卡")).toBeNull();
  });
});
