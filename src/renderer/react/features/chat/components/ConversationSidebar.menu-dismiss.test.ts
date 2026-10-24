// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { isInsideSessionMenu } from "./ConversationSidebar";

function element(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

it("keeps the conversation menu open for clicks in the menu and in its submenu popups on the body", () => {
  expect(isInsideSessionMenu(element('<div class="ff-session-context-menu"><li><span id="t">重命名</span></li></div>', "#t"))).toBe(true);
  // Ant Design portals submenus to document.body, outside the menu's wrapper.
  expect(isInsideSessionMenu(element('<div class="ant-menu-submenu-popup ff-session-context-submenu"><ul><li id="t">复制标题</li></ul></div>', "#t"))).toBe(true);
});

it("dismisses the menu for a click anywhere else, including another menu's popup", () => {
  expect(isInsideSessionMenu(element('<main><button id="t">elsewhere</button></main>', "#t"))).toBe(false);
  expect(isInsideSessionMenu(element('<div class="ant-menu-submenu-popup"><li id="t">other</li></div>', "#t"))).toBe(false);
});
