// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { activateDialogFocus } from "./dialog-focus";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture(contents: string) {
  const opener = document.body.appendChild(document.createElement("button"));
  opener.textContent = "Show details";
  const panel = document.body.appendChild(document.createElement("section"));
  panel.innerHTML = contents;
  opener.focus();
  const select = (selector: string) => panel.querySelector<HTMLElement>(selector)!;
  const key = (value: string, backwards = false) => panel.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey: backwards, bubbles: true }));
  return { opener, panel, select, key };
}

describe("Keyboard navigation within a settings dialog", () => {
  it("starts on the safe action, wraps Tab, handles Escape once and restores the opener", () => {
    const view = fixture('<button data-action="cancel">Keep</button><button data-action="accept">Remove</button>');
    const safe = view.select('[data-action="cancel"]'), destructive = view.select('[data-action="accept"]');
    const escape = vi.fn(), dispose = activateDialogFocus(view.panel, safe, escape);
    expect(document.activeElement).toBe(safe);
    destructive.focus();
    view.key("Tab");
    expect(document.activeElement).toBe(safe);
    view.key("Escape");
    expect(escape.mock.calls).toStrictEqual([[]]);
    dispose();
    expect(document.activeElement).toBe(view.opener);
    view.key("Escape");
    expect(escape).toHaveBeenCalledTimes(1);
  });

  it.each(["hidden", "inert", 'aria-hidden="true"'])("skips details inside a %s container in both directions", (hidden) => {
    const view = fixture(`<details ${hidden}><summary>Technical details</summary><pre>Diagnostic</pre></details><button data-safe>Keep</button><button data-risk>Remove</button>`);
    const safe = view.select("[data-safe]"), risky = view.select("[data-risk]");
    const dispose = activateDialogFocus(view.panel, safe, vi.fn());
    expect(document.activeElement).toBe(safe);
    view.key("Tab", true);
    expect(document.activeElement).toBe(risky);
    view.key("Tab");
    expect(document.activeElement).toBe(safe);
    dispose();
  });

  it("includes a visible summary as the first focus stop", () => {
    const view = fixture('<details open><summary>Diagnostics</summary><pre>Readable text</pre></details><button>Dismiss</button>');
    const button = view.select("button"), summary = view.select("summary");
    const dispose = activateDialogFocus(view.panel, button, vi.fn());
    view.key("Tab");
    expect(document.activeElement).toBe(summary);
    view.key("Tab", true);
    expect(document.activeElement).toBe(button);
    dispose();
  });

  it("includes navigable help links in the focus cycle", () => {
    const view = fixture('<button>Dismiss</button><a href="#help">Read help</a>');
    const button = view.select("button"), link = view.select("a");
    const dispose = activateDialogFocus(view.panel, button, vi.fn());
    link.focus();
    view.key("Tab");
    expect(document.activeElement).toBe(button);
    dispose();
  });
});
