// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { aguiApi, chatStore, choiceApi, settingsApprovalApi, sidebarApi } from "./chat-page-bridge";
const cases = [["chatStore", chatStore], ["sidebar", sidebarApi], ["agui", aguiApi], ["choice", choiceApi], ["settings", settingsApprovalApi]] as const;
afterEach(() => { for (const [key] of cases) delete (window as any)[key]; });
it.each(cases)("returns undefined when %s preload is absent", (key, get) => { delete (window as any)[key]; expect(get()).toBeUndefined(); });
it.each(cases)("reads the current %s bridge without caching or cloning", (key, get) => { const first = {}, second = {}; (window as any)[key] = first; expect(get()).toBe(first); (window as any)[key] = second; expect(get()).toBe(second); });
