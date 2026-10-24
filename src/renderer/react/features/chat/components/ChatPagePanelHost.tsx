import type { ChatPagePanel } from "./ChatPageNavigation";
import { ModelModePanel } from "./ModelModePanel";
import { PluginModePanel } from "./PluginModePanel";
import { ScheduledTaskPanel } from "./ScheduledTaskPanel";
import { SkillModePanel } from "./SkillModePanel";
import { ToolModePanel } from "./ToolModePanel";

export function ChatPagePanelHost({ panel: selection }: { panel: ChatPagePanel }) {
  if (selection === "model") return <ModelModePanel />;
  if (selection === "plugin") return <PluginModePanel />;
  if (selection === "scheduled") return <ScheduledTaskPanel />;
  if (selection === "skill") return <SkillModePanel />;
  if (selection === "tool") return <ToolModePanel />;
}
