import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ComposerSlot } from "./ComposerSlot";
import type { PermissionInteraction } from "./run-presentation";

vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("span", null, content),
}));

const permission: PermissionInteraction = {
  kind: "permission",
  id: "p1",
  toolName: "write_file",
  summary: "写入文件",
};

function render(props: { interactionPending?: number; withInteraction?: boolean }): string {
  return renderToStaticMarkup(createElement(ComposerSlot, {
    composer: createElement("div", null, "composer"),
    interaction: props.withInteraction === false ? undefined : permission,
    interactionPending: props.interactionPending,
  }));
}

describe("ComposerSlot approval queue", () => {
  beforeAll(() => {
    vi.stubGlobal("React", React);
  });

  it("tells how many approvals wait behind the visible card", () => {
    const html = render({ interactionPending: 2 });

    expect(html).toContain("ff-composer-slot__pending");
    expect(html).toContain("还有 2 项待处理");
  });

  it("shows no queue pill for a single card or without a card", () => {
    expect(render({ interactionPending: 0 })).not.toContain("ff-composer-slot__pending");
    expect(render({})).not.toContain("ff-composer-slot__pending");
    expect(render({ interactionPending: 3, withInteraction: false })).not.toContain("ff-composer-slot__pending");
  });
});
