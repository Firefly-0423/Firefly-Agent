import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "vitest";

const feedbackOwners = ["api/fetch-models-controller.ts", "api/endpoint-view.ts", "settings.ts", "general/panel.ts", "preferences/chat-panel.ts", "preferences/firefly-panel.ts", "appearance/panel.ts", "preferences/panel.ts", "memory/panel.ts", "channels/panel.ts", "rag/panel.ts", "scheduler/panel.ts", "mcp/panel.ts", "shared/preview-bridge.ts", "shared/option-group.ts", "shared/section-router.ts", "music/panel.ts"];

test.each(feedbackOwners)("%s uses the shared feedback API rather than native or legacy dialogs", relative => {
  const code = readFileSync(resolve(__dirname, relative), "utf8");
  const forbiddenCalls = code.match(/\b(?:window\.)?(?:alert|confirm)\s*\(|\bshowModal\s*\(/g) ?? [];
  expect(forbiddenCalls).toHaveLength(0);
});
