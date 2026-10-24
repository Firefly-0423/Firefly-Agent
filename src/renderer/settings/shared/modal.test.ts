// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { showHtmlModal, showInputModal, showAlert, showNotice, showConfirm } from "./modal";

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const click = (id: string) => element<HTMLButtonElement>(id).click();
function hidden(id: string) {
  const overlay = document.getElementById(id);
  return overlay === null || overlay.classList.contains("is-hidden");
}
let launcher: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  launcher = document.body.appendChild(document.createElement("button"));
  launcher.textContent = "Open preferences";
  launcher.focus();
});
afterEach(() => {
  window.dispatchEvent(new Event("beforeunload"));
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  launcher.remove();
});

describe("Settings dialog queue visible behavior", () => {
  it("serializes alert, confirmation, input and rich text without stacking overlays", async () => {
    const alert = showAlert({ tone: "info", title: "Review settings", message: "Read before continuing" });
    const confirm = showConfirm({ title: "Apply changes", message: "Continue to naming?" });
    const input = showInputModal({ title: "Choose a label", message: "Enter a label for the profile" });
    const html = showHtmlModal({ title: "Profile information", htmlBody: "<p>Saved profile information</p>" });
    expect(element("ff-modal-title").textContent).toEqual("Review settings");
    expect(hidden("ff-input-overlay")).toEqual(true);
    expect(hidden("ff-html-modal-overlay")).toEqual(true);
    click("ff-modal-confirm");
    await expect(alert).resolves.toEqual(undefined);
    expect(element("ff-modal-title").textContent).toEqual("Apply changes");
    expect(hidden("ff-input-overlay")).toEqual(true);
    click("ff-modal-confirm");
    await expect(confirm).resolves.toEqual(true);
    expect(hidden("ff-input-overlay")).toEqual(false);
    expect(document.activeElement).toBe(element("ff-input-field"));
    element<HTMLInputElement>("ff-input-field").value = "Research profile";
    click("ff-input-confirm");
    await expect(input).resolves.toEqual("Research profile");
    expect(hidden("ff-html-modal-overlay")).toEqual(false);
    expect(element("ff-html-modal-title").textContent).toEqual("Profile information");
    click("ff-html-modal-confirm");
    await expect(html).resolves.toEqual(undefined);
  });

  it("keeps a rich-text request hidden until the preceding alert resolves", async () => {
    const first = showAlert({ tone: "info", title: "Connection overview", message: "Read this first" });
    const second = showHtmlModal({ title: "Endpoint guide", htmlBody: "<p>Endpoint instructions</p>" });
    expect(hidden("ff-html-modal-overlay")).toEqual(true);
    click("ff-modal-confirm");
    await first;
    expect(hidden("ff-html-modal-overlay")).toEqual(false);
    expect(element("ff-html-modal-title").textContent).toEqual("Endpoint guide");
    click("ff-html-modal-confirm");
    await expect(second).resolves.toEqual(undefined);
  });

  it("presents one alert action and treats diagnostic markup as plain text", async () => {
    const details = '<img src="invalid" onerror="compromise()">';
    const result = showAlert({ tone: "error", title: "Profile unavailable", message: "Check the diagnostics", details });
    expect(document.querySelectorAll("#ff-modal-overlay button").length).toEqual(1);
    expect(document.querySelector(".ff-modal__details")?.textContent).toEqual(details);
    expect(document.querySelector(".ff-modal__details img")).toEqual(null);
    click("ff-modal-confirm");
    await expect(result).resolves.toEqual(undefined);
  });

  it("focuses cancellation for destructive actions, traps focus, ignores backdrop clicks and restores focus", async () => {
    const result = showConfirm({ title: "Remove a profile", message: "This cannot be undone", dangerous: true, confirmText: "Remove profile" });
    const safe = element("ff-modal-cancel"), risky = element("ff-modal-confirm");
    const panel = document.querySelector<HTMLElement>("#ff-modal-overlay .ff-modal")!;
    expect(document.activeElement).toBe(safe);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(risky);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(safe);
    element("ff-modal-overlay").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(hidden("ff-modal-overlay")).toEqual(false);
    safe.click();
    await expect(result).resolves.toEqual(false);
    expect(document.activeElement).toBe(launcher);
  });

  it("moves from the first alert to a queued confirmation in FIFO order", async () => {
    const first = showAlert({ tone: "info", title: "Earlier request", message: "Acknowledge" });
    const second = showConfirm({ title: "Later request", message: "Decide" });
    expect(element("ff-modal-title").textContent).toEqual("Earlier request");
    click("ff-modal-confirm");
    await first;
    expect(element("ff-modal-title").textContent).toEqual("Later request");
    click("ff-modal-cancel");
    await expect(second).resolves.toEqual(false);
  });

  it("settles only the active input listener and cancels the next request separately", async () => {
    const first = showInputModal({ title: "Primary name", message: "Name the first profile" });
    const second = showInputModal({ title: "Secondary name", message: "Name the second profile" });
    expect(element("ff-input-title").textContent).toEqual("Primary name");
    element<HTMLInputElement>("ff-input-field").value = "Primary profile";
    click("ff-input-confirm");
    await expect(first).resolves.toEqual("Primary profile");
    expect(element("ff-input-title").textContent).toEqual("Secondary name");
    click("ff-input-cancel");
    await expect(second).resolves.toEqual(null);
  });

  it("resolves both an active input and a queued destructive request safely on unload", async () => {
    const input = showInputModal({ title: "Unsaved name", message: "Enter a name" });
    const confirm = showConfirm({ title: "Queued removal", message: "Requires explicit approval" });
    window.dispatchEvent(new Event("beforeunload"));
    await expect(input).resolves.toEqual(null);
    await expect(confirm).resolves.toEqual(false);
  });
});

describe("Nonblocking notice lifetime and capacity", () => {
  it("deduplicates equal messages and refuses a fourth distinct notice", () => {
    showNotice({ message: "Profile saved", tone: "success" });
    showNotice({ message: "Profile saved", tone: "success" });
    showNotice({ message: "Catalog refreshed", tone: "info" });
    showNotice({ message: "Model offline", tone: "warning" });
    showNotice({ message: "Excess notice", tone: "error" });
    expect(Array.from(document.querySelectorAll(".ff-notice__message"), node => node.textContent))
      .toStrictEqual(["Profile saved", "Catalog refreshed", "Model offline"]);
    expect(document.body.textContent?.match(/Profile saved/g)?.length).toEqual(1);
  });

  it("remains visible until the three-second default expires", () => {
    showNotice({ message: "Preferences applied", tone: "success" });
    vi.advanceTimersByTime(2999);
    expect(document.querySelector(".ff-notice")).not.toEqual(null);
    vi.advanceTimersByTime(1);
    expect(document.querySelector(".ff-notice")).toEqual(null);
  });
});
