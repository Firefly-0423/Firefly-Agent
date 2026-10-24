import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ConversationSidebar } from "./ConversationSidebar";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ confirm: vi.fn() }) }));
const longTitle = "A legacy conversation with a very long title ".repeat(6);
const sessions: ChatSessionMeta[] = [
  { id: "old-pinned", title: longTitle, mode: "chat", pinned: true, createdAt: 1, updatedAt: 2, messageCount: 3 },
  { id: "old-recent", title: "Older transcript", mode: "chat", createdAt: 1, updatedAt: 3, messageCount: 2 },
];
it("shows pinned and recent legacy history without changing IDs or hiding long titles", () => {
  const html = renderToStaticMarkup(createElement(ConversationSidebar, {
    mode: "chat", listStatus: "ready", sessions, activeSessionId: "old-recent",
    onSelect: vi.fn(), onOpenProject: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn(), onExport: vi.fn(),
  }));
  expect(html).toContain("sidebar.pinnedTitle");
  expect(html).toContain("sidebar.recentTitle");
  expect(html).toContain('data-session-id="old-pinned"');
  expect(html).toContain('data-session-id="old-recent"');
  expect(html).toContain(`title="${longTitle}"`);
  expect(sessions[0].id).toBe("old-pinned");
});
it("keeps the project entry when every legacy project session is pinned", () => {
  const html = renderToStaticMarkup(createElement(ConversationSidebar, {
    mode: "code", listStatus: "ready", sessions: [{ ...sessions[0], mode: "code", workspaceRoot: "E:\\fixture", workspaceDisplayName: "Pinned project" }],
    onSelect: vi.fn(), onOpenProject: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn(), onExport: vi.fn(),
  }));
  expect(html).toContain("ff-conversation-project");
  expect(html).toContain("Pinned project");
  expect(html).toContain('data-pinned="true"');
});
