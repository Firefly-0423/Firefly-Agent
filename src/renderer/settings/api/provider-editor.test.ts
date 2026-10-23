// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProviderEditorLayout,
  mountProfileEditor,
  parkProfileEditor,
  placeSaveStatus,
  renderKeepingProfileEditor,
} from "./provider-editor";

const baseHtml = `
  <div id="provider-primary-fields"></div>
  <details id="provider-connection-more">
    <div id="provider-connection-more-fields">
      <div data-provider-field="display"><input id="display-name" /></div>
      <div data-provider-field="url"><input id="base-url" /></div>
      <div data-provider-field="transport"><select id="transport-select"></select></div>
      <div data-provider-field="key"><input id="api-key" /></div>
    </div>
  </details>
  <div id="provider-preset-page"></div>
  <button data-provider-tab="preset"></button>
  <button data-provider-tab="custom"></button>
  <ul id="model-profile-list"></ul>
  <div id="provider-editor-slot"></div>
  <div id="profile-editor"><input id="draft" /></div>
  <div id="provider-status-slot"></div>
  <div id="provider-status-top"></div>
  <div id="save-status"></div>
`;

function makeRoot(): HTMLElement {
  document.body.innerHTML = baseHtml;
  return document.body;
}

function field(id: string): HTMLElement {
  return document.getElementById(id)!.closest<HTMLElement>("[data-provider-field]")!;
}

function addProfileCard(id: string): HTMLElement {
  const card = document.createElement("div");
  card.dataset.profileId = id;
  document.getElementById("model-profile-list")!.append(card);
  return card;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("applyProviderEditorLayout", () => {
  it("keeps API key in the primary area and moves preset details into custom settings", () => {
    const root = makeRoot();
    applyProviderEditorLayout(root, "preset");

    expect(field("api-key").closest("#provider-primary-fields")).not.toBeNull();
    for (const id of ["display-name", "base-url", "transport-select"]) {
      expect(field(id).closest("#provider-connection-more-fields"), id).not.toBeNull();
    }
    expect(document.getElementById("provider-connection-more")!.hidden).toBe(false);
    expect(document.getElementById("provider-preset-page")!.hidden).toBe(false);
    expect(document.querySelector('[data-provider-tab="preset"]')!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>('[data-provider-tab="preset"]')!.tabIndex).toBe(0);
    expect(document.querySelector<HTMLButtonElement>('[data-provider-tab="custom"]')!.tabIndex).toBe(-1);
  });

  it("keeps every connection field primary and hides the preset page for custom APIs", () => {
    const root = makeRoot();
    applyProviderEditorLayout(root, "custom");

    for (const id of ["display-name", "api-key", "base-url", "transport-select"]) {
      expect(field(id).closest("#provider-primary-fields"), id).not.toBeNull();
    }
    expect(document.getElementById("provider-connection-more")!.hidden).toBe(true);
    expect(document.getElementById("provider-preset-page")!.hidden).toBe(true);
    expect(document.querySelector('[data-provider-tab="custom"]')!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>('[data-provider-tab="custom"]')!.tabIndex).toBe(0);
  });

  it("hides the preset page while editing an existing preset profile", () => {
    const root = makeRoot();
    applyProviderEditorLayout(root, "preset", true);
    expect(document.getElementById("provider-preset-page")!.hidden).toBe(true);
  });

  it("skips fields without a [data-provider-field] wrapper and tolerates missing anchors", () => {
    const root = makeRoot();
    document.getElementById("api-key")!.parentElement!.removeAttribute("data-provider-field");
    const orphan = document.createElement("input");
    orphan.id = "base-url";
    document.getElementById("api-key")!.after(orphan);
    expect(() => applyProviderEditorLayout(root, "preset")).not.toThrow();

    document.body.innerHTML = '<div id="provider-primary-fields"></div>';
    expect(() => applyProviderEditorLayout(document.body, "preset")).not.toThrow();
  });
});

describe("mountProfileEditor", () => {
  it("mounts under the edited profile card", () => {
    const root = makeRoot();
    const card = addProfileCard("profile-1");
    addProfileCard("profile-2");

    mountProfileEditor(root, "profile-2");

    expect(document.getElementById("profile-editor")!.parentElement).toBe(
      root.querySelector('[data-profile-id="profile-2"]'),
    );
    expect(card.contains(document.getElementById("profile-editor"))).toBe(false);
  });

  it("mounts in the slot when creating or when the profile no longer exists", () => {
    const root = makeRoot();
    addProfileCard("profile-1");
    const editor = document.getElementById("profile-editor")!;
    const slot = document.getElementById("provider-editor-slot")!;

    mountProfileEditor(root, "missing");
    expect(editor.parentElement).toBe(slot);

    addProfileCard("profile-1");
    mountProfileEditor(root, undefined);
    expect(editor.parentElement).toBe(slot);
  });

  it("restores focus inside the editor when it has to move", () => {
    const root = makeRoot();
    addProfileCard("profile-1");
    const input = document.getElementById("draft") as HTMLInputElement;
    input.focus();
    const focus = vi.spyOn(input, "focus");

    mountProfileEditor(root, "profile-1");

    expect(focus).toHaveBeenCalled();
    expect(document.getElementById("profile-editor")!.parentElement).toBe(
      root.querySelector('[data-profile-id="profile-1"]'),
    );
  });

  it("does not move or refocus when already mounted as the host's last child", () => {
    const root = makeRoot();
    parkProfileEditor(root);
    const input = document.getElementById("draft") as HTMLInputElement;
    input.focus();
    const focus = vi.spyOn(input, "focus");

    mountProfileEditor(root, undefined);

    expect(focus).not.toHaveBeenCalled();
    expect(document.getElementById("profile-editor")!.parentElement).toBe(
      document.getElementById("provider-editor-slot"),
    );
  });

  it("is a no-op when the editor or slot is absent", () => {
    document.body.innerHTML = '<div id="profile-editor"></div>';
    expect(() => mountProfileEditor(document.body, "anything")).not.toThrow();
    document.body.innerHTML = '<div id="provider-editor-slot"></div>';
    expect(() => mountProfileEditor(document.body, "anything")).not.toThrow();
  });
});

describe("parkProfileEditor", () => {
  it("parks the editor back in the slot before a list redraw", () => {
    const root = makeRoot();
    const card = addProfileCard("profile-1");
    const editor = document.getElementById("profile-editor")!;
    card.append(editor);

    parkProfileEditor(root);

    expect(editor.parentElement).toBe(document.getElementById("provider-editor-slot"));
  });

  it("does nothing when the editor is already parked or nodes are missing", () => {
    const root = makeRoot();
    const editor = document.getElementById("profile-editor")!;
    expect(() => parkProfileEditor(root)).not.toThrow();
    expect(editor.parentElement).toBe(document.getElementById("provider-editor-slot"));

    document.body.innerHTML = "<div></div>";
    expect(() => parkProfileEditor(document.body)).not.toThrow();
  });
});

describe("renderKeepingProfileEditor", () => {
  it("parks before render and remounts with focus afterwards", () => {
    const root = makeRoot();
    addProfileCard("old");
    const editor = document.getElementById("profile-editor")!;
    root.querySelector('[data-profile-id="old"]')!.append(editor);
    const input = document.getElementById("draft") as HTMLInputElement;
    input.focus();
    const focus = vi.spyOn(input, "focus");
    let parkedDuringRender = false;
    const render = vi.fn(() => {
      parkedDuringRender =
        editor.parentElement === document.getElementById("provider-editor-slot");
      document.getElementById("model-profile-list")!.replaceChildren();
      addProfileCard("new");
    });

    renderKeepingProfileEditor(root, "new", render);

    expect(render).toHaveBeenCalledTimes(1);
    expect(parkedDuringRender).toBe(true);
    expect(editor.parentElement).toBe(root.querySelector('[data-profile-id="new"]'));
    expect(focus).toHaveBeenCalled();
  });

  it("survives a render that removes the edited card and falls back to the slot", () => {
    const root = makeRoot();
    addProfileCard("old");
    const editor = document.getElementById("profile-editor")!;
    root.querySelector('[data-profile-id="old"]')!.append(editor);

    renderKeepingProfileEditor(root, "old", () => {
      document.getElementById("model-profile-list")!.replaceChildren();
    });

    expect(editor.parentElement).toBe(document.getElementById("provider-editor-slot"));
  });
});

describe("placeSaveStatus", () => {
  it("moves the status next to the footer while the editor is open", () => {
    const root = makeRoot();
    const status = document.getElementById("save-status")!;

    placeSaveStatus(root, true);
    expect(status.parentElement).toBe(document.getElementById("provider-status-slot"));

    placeSaveStatus(root, false);
    expect(status.parentElement).toBe(document.getElementById("provider-status-top"));
  });

  it("leaves the status alone when the target host or status is missing", () => {
    const root = makeRoot();
    const status = document.getElementById("save-status")!;
    placeSaveStatus(root, true);
    const slot = document.getElementById("provider-status-slot")!;
    slot.remove();

    expect(() => placeSaveStatus(root, true)).not.toThrow();
    expect(status.parentElement).toBe(slot);

    document.body.innerHTML = '<div id="provider-status-slot"></div>';
    expect(() => placeSaveStatus(document.body, true)).not.toThrow();
  });
});
