import type { ApiTransport } from "../../../shared/api-endpoint";
import type { ReasoningLevelsConfig, ReasoningPreference } from "../../../shared/reasoning";
import type { InputModality, InputModalitySource } from "../../../shared/input-modalities";
import type { CustomEndpointMode } from "../custom-endpoint-state";

// 编辑器需要的档案字段。
export interface SavedProfileLite {
  id: string; provider: string;
  displayName?: string; baseUrl: string;
  model: string; apiKey: string;
  explicitTransport?: ApiTransport; reasoning?: ReasoningPreference;
  reasoningLevels?: ReasoningLevelsConfig; contextWindowTokens?: number;
  inputModalities?: InputModality[]; inputModalitiesSource?: InputModalitySource;
}

type ProfileEditorState = {
  editorOpen: boolean;
  activeProvider: string;
  customEndpointMode: CustomEndpointMode;
  editingProfileId: string | undefined;
  editingReasoning: ReasoningPreference | undefined;
  profiles: SavedProfileLite[];
  profilesLoadState: "loading" | "error" | "ready";
  defaultProfileId: string | undefined;
};

// 保留共享状态的字段顺序。
export const apiState: ProfileEditorState = {
  editorOpen: false, activeProvider: "",
  customEndpointMode: "cloud", editingProfileId: undefined,
  editingReasoning: undefined, profiles: [],
  profilesLoadState: "loading", defaultProfileId: undefined,
};
