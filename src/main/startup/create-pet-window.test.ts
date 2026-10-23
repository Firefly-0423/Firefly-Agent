import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, unknown>> = [];

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(options: Record<string, unknown>) { created.push(options); }
    loadURL() {}
    loadFile() {}
    setIgnoreMouseEvents() {}
    on() {}
    once() {}
  }
  return {
    app: { getAppPath: () => "app" },
    BrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    },
  };
});

import { createPetWindow } from "./create-pet-window";

describe("createPetWindow", () => {
  beforeEach(() => { created.length = 0; });

  it("is not focusable, so clicking the pet leaves the main window (and its embedded browser) focused", () => {
    createPetWindow({ loadGeneralSettings: () => ({}), getCurrentAppIconPath: () => "icon.png", isDev: false });
    expect(created).toHaveLength(1);
    expect(created[0].focusable).toBe(false);
    expect(created[0].skipTaskbar).toBe(true);
  });
});
