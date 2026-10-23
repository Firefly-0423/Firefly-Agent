import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ConversationSidebar } from "./ConversationSidebar";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ confirm: vi.fn() }) }));

it.each(["chat", "work"] as const)("distinguishes loading, read failure and genuine empty %s history", (mode) => {
  for (const listStatus of ["loading", "error", "ready"] as const) {
    const html = renderToStaticMarkup(createElement(ConversationSidebar, {
      mode, listStatus, sessions: [], onSelect: vi.fn(), onOpenProject: vi.fn(),
      onRename: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn(), onExport: vi.fn(),
    }));
    const emptyKey = mode === "chat" ? "sidebar.emptyConversations" : "sidebar.emptyProjects";
    expect(html).toContain(listStatus === "loading" ? "sidebar.listLoading" : listStatus === "error" ? "sidebar.listFailed" : emptyKey);
    if (listStatus !== "ready") expect(html).not.toContain(emptyKey);
  }
});
