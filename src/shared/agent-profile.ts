export interface AgentProfile {
  id: string;
  nickname: string;
  role: string;
  description: string;
  systemPrompt: string;
  modelProfile: string;
  allowedToolIds: readonly string[];
  allowedSkillIds: readonly string[];
  supportedModes: readonly ("work" | "code")[];
  persistent: true;
  timeoutMs: number;
  maxConcurrency: 1;
}
