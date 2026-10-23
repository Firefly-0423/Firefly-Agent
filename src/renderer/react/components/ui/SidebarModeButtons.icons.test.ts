import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ModelModeButton } from "./ModelModeButton";
import { PluginModeButton } from "./PluginModeButton";
import { SkillModeButton } from "./SkillModeButton";
import { ToolModeButton } from "./ToolModeButton";

describe("sidebar mode buttons", () => {
  beforeAll(() => {
    (globalThis as { React?: unknown }).React = React;
  });

  it.each([
    ["tools", ToolModeButton],
    ["skills", SkillModeButton],
    ["model", ModelModeButton],
    ["plugins", PluginModeButton],
  ] as const)("draws the %s entry with the shared line icon, not a text glyph", (_name, Button) => {
    const html = renderToStaticMarkup(createElement(Button, {}));

    expect(html).toContain("<svg");
    expect(html).toContain('width="16"');
    expect(html).toContain('stroke-width="1.8"');
    expect(html).not.toMatch(/[⚙✦◇]/u);
  });
});
