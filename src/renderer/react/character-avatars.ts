import { TASK_CHARACTERS } from "../../shared/task-characters";
import { getCharacterPortraitByAssetFileName } from "./character-portraits";

export function getCharacterAvatar(nickname: string): string | null {
  const character = TASK_CHARACTERS.find((entry) => entry.nickname === nickname);
  return character ? getCharacterPortraitByAssetFileName(character.assetFileName) : null;
}
