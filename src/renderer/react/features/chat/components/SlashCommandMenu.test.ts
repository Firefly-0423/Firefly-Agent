// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterSlashItems, slashQuery, useSlashCommands, type SlashItem } from "./SlashCommandMenu";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("slash parsing", () => {
  it("opens only for a single word that starts with a slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/Comp")).toBe("comp");
    expect(slashQuery("/compact now")).toBeNull();
    expect(slashQuery("hello /compact")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
  it("puts commands before skills and prefix matches first", () => {
    const items: SlashItem[] = [
      { name: "code-review", description: "审查代码", kind: "skill" },
      { name: "compact", description: "压缩", kind: "command" },
      { name: "clear", description: "清空", kind: "command" },
      { name: "recode", description: "x", kind: "skill" },
    ];
    expect(filterSlashItems(items, "c").map(item => item.name)).toEqual(["clear", "compact", "code-review", "recode"]);
    expect(filterSlashItems(items, "审查").map(item => item.name)).toEqual(["code-review"]);
  });
});

describe("slash menu", () => {
  let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
  let api: ReturnType<typeof useSlashCommands>;
  const onChange = vi.fn(), onNewTask = vi.fn(), onNotice = vi.fn();
  const compactConversation = vi.fn(async () => ({ ok: true }));
  function Probe({ value }: { value: string }) {
    api = useSlashCommands({ value, mode: "code", conversationId: "s1", onChange, onNewTask, onNotice });
    return api.menu;
  }
  const show = async (value: string) => { await act(async () => { root.render(React.createElement(Probe, { value })); }); };
  const key = (name: string) => {
    let handled = false;
    act(() => { handled = api.onKeyDown({ key: name, shiftKey: false, preventDefault() {}, nativeEvent: { isComposing: false } } as never); });
    return handled;
  };
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    onChange.mockClear(); onNewTask.mockClear(); onNotice.mockClear(); compactConversation.mockClear();
    (window as never as { settings: unknown }).settings = { getSkillCatalog: async () => [
      { id: "code-review", name: "Review", description: "Reviews", descriptionZh: "审查代码", enabled: true, modes: null },
      { id: "off-skill", name: "Off", description: "Off", enabled: false, modes: null },
      { id: "work-only", name: "W", description: "W", enabled: true, modes: ["work"] },
      { id: "turned-on", name: "On", description: "On", enabled: true, modes: ["work"] },
      { id: "turned-off", name: "Off2", description: "Off2", enabled: true, modes: null },
    ], getSkillModeOverrides: async () => ({ "turned-on": { code: true }, "turned-off": { code: false } }) };
    (window as never as { chatStore: unknown }).chatStore = { compactConversation };
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("lists commands and the enabled skills of this mode, with Chinese descriptions", async () => {
    await show("/");
    const names = [...host.querySelectorAll(".ff-slash-menu__name")].map(node => node.textContent);
    expect(names).toEqual(["/clear", "/compact", "/new", "/code-review", "/turned-on"]);
    expect(host.textContent).toContain("审查代码");
  });

  it("runs /compact on the conversation and reports the result", async () => {
    await show("/comp");
    expect(key("Enter")).toBe(true);
    expect(onChange).toHaveBeenCalledWith("");
    await act(async () => { await Promise.resolve(); });
    expect(compactConversation).toHaveBeenCalledWith("s1");
    expect(onNotice).toHaveBeenCalledWith("slash.compactDone", "success");
  });

  it("fills a skill command into the input, moving with the arrow keys", async () => {
    await show("/");
    key("ArrowUp");
    expect(key("Tab")).toBe(true);
    expect(onChange).toHaveBeenCalledWith("/turned-on ");
  });

  it("starts a new task with /new and closes on Escape without running anything", async () => {
    await show("/new");
    key("Enter");
    expect(onNewTask).toHaveBeenCalledOnce();
    await show("/cl");
    expect(key("Escape")).toBe(true);
    await show("/cl");
    expect(host.querySelector(".ff-slash-menu")).toBeNull();
    expect(key("Enter")).toBe(false);
  });

  it("stays closed for ordinary text", async () => {
    await show("hello");
    expect(host.querySelector(".ff-slash-menu")).toBeNull();
    expect(key("Enter")).toBe(false);
  });

  it("withholds /compact while a run is in flight", async () => {
    function Busy({ value }: { value: string }) {
      api = useSlashCommands({ value, mode: "code", conversationId: "s1", busy: true, onChange, onNewTask, onNotice });
      return api.menu;
    }
    await act(async () => { root.render(React.createElement(Busy, { value: "/comp" })); });
    expect(host.textContent).not.toContain("/compact");
    expect(compactConversation).not.toHaveBeenCalled();
  });
});
