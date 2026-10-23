// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const domState = vi.hoisted(() => ({
  wrap: null as HTMLElement | null,
  note: null as HTMLElement | null,
}));
const modalMock = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("./dom", () => ({
  get permissionBlocksWrap() {
    return domState.wrap;
  },
  get permissionNote() {
    return domState.note;
  },
}));
vi.mock("../shared/modal", () => ({ _initModalOverlay: modalMock.init }));

const LEVELS = ["project-read-only", "read-only", "scoped", "per-action", "full"] as const;

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

interface SetupOptions {
  getPermissionLevel?: () => Promise<unknown>;
  overlay?: boolean;
}

async function setup(options: SetupOptions = {}) {
  vi.resetModules();
  document.body.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.id = "plugin-file-permission";
  for (const level of LEVELS) {
    const button = document.createElement("button");
    button.dataset.level = level;
    button.textContent = level;
    if (level === "read-only") button.classList.add("is-active");
    wrap.append(button);
  }
  const note = document.createElement("p");
  note.id = "plugin-file-note";
  document.body.append(wrap, note);

  const overlay = document.createElement("div");
  overlay.id = "ff-modal-overlay";
  overlay.className = "ff-modal-overlay is-hidden";
  overlay.innerHTML = [
    '<span id="ff-modal-icon"></span>',
    '<h2 id="ff-modal-title"></h2>',
    '<p id="ff-modal-message"></p>',
    '<button id="ff-modal-cancel"></button>',
    '<button id="ff-modal-confirm"></button>',
  ].join("");
  document.body.append(overlay);

  domState.wrap = wrap;
  domState.note = note;

  const api = {
    getPermissionLevel: vi.fn(
      options.getPermissionLevel ?? (async () => ({ level: "read-only" })),
    ),
    setPermissionLevel: vi.fn(async () => ({ ok: true as const })),
  };
  (window as unknown as { settings: unknown }).settings = api;

  const modalStateModule = await import("../shared/modal-state");
  modalStateModule.modalState.ffOverlay = options.overlay === false ? null : overlay;

  await import("./permission");
  await flush();

  const button = (level: string) =>
    wrap.querySelector<HTMLButtonElement>(`button[data-level="${level}"]`)!;
  const cancel = overlay.querySelector<HTMLButtonElement>("#ff-modal-cancel")!;
  const confirm = overlay.querySelector<HTMLButtonElement>("#ff-modal-confirm")!;
  return { api, wrap, note, overlay, cancel, confirm, button, modalState: modalStateModule.modalState };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  domState.wrap = null;
  domState.note = null;
});

describe("permission level initialization", () => {
  it("paints the loaded level, mapping scoped to the visible read-only button", async () => {
    const { note, button } = await setup({
      getPermissionLevel: async () => ({ level: "scoped" }),
    });

    expect(button("read-only").classList.contains("is-active")).toBe(true);
    expect(button("read-only").getAttribute("aria-pressed")).toBe("true");
    expect(button("scoped").classList.contains("is-active")).toBe(false);
    expect(button("full").getAttribute("aria-pressed")).toBe("false");
    expect(note.textContent).toContain("指定目录");
  });

  it("defaults to read-only when the backend omits a level", async () => {
    const { note, button } = await setup({ getPermissionLevel: async () => ({}) });
    expect(button("read-only").classList.contains("is-active")).toBe(true);
    expect(note.textContent).toContain("只读");
  });

  it("falls back to read-only when loading rejects", async () => {
    const { note, button } = await setup({
      getPermissionLevel: async () => {
        throw new Error("synthetic load failure");
      },
    });
    expect(button("read-only").classList.contains("is-active")).toBe(true);
    expect(note.textContent).toContain("只读");
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("permission changes", () => {
  it("saves a clicked level and paints the level returned by the host", async () => {
    const { api, note, button } = await setup();
    api.setPermissionLevel.mockResolvedValue({ ok: true, level: "full" });

    button("per-action").click();
    await flush();

    expect(api.setPermissionLevel).toHaveBeenCalledWith("per-action");
    expect(button("full").classList.contains("is-active")).toBe(true);
    expect(note.textContent).toContain("完全访问");
  });

  it("falls back to the clicked level when the host does not return one", async () => {
    const { api, button } = await setup();
    api.setPermissionLevel.mockResolvedValue({ ok: true });

    button("project-read-only").click();
    await flush();

    expect(button("project-read-only").classList.contains("is-active")).toBe(true);
  });

  it("does nothing for an already-active button or a non-button target", async () => {
    const { api, wrap, button } = await setup();

    button("read-only").click();
    wrap.click();
    await flush();

    expect(api.setPermissionLevel).not.toHaveBeenCalled();
  });

  it("keeps the previous level when saving fails or throws", async () => {
    const { api, note, button } = await setup();
    api.setPermissionLevel.mockResolvedValue({ ok: false, error: "synthetic failure" });

    button("per-action").click();
    await flush();
    expect(button("read-only").classList.contains("is-active")).toBe(true);
    expect(note.textContent).toContain("只读");
    expect(console.warn).toHaveBeenCalled();

    api.setPermissionLevel.mockRejectedValue(new Error("synthetic exception"));
    button("scoped").click();
    await flush();
    expect(button("read-only").classList.contains("is-active")).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("full access confirmation", () => {
  it("requires a five-second delay before enabling the confirm button", async () => {
    vi.useFakeTimers();
    const { api, button, overlay, cancel, confirm } = await setup();
    api.setPermissionLevel.mockResolvedValue({ ok: true, level: "full" });

    button("full").click();
    await flush();

    expect(modalMock.init).toHaveBeenCalled();
    expect(overlay.classList.contains("is-hidden")).toBe(false);
    expect(overlay.querySelector("#ff-modal-icon")?.textContent).toBe("⚠️");
    expect(overlay.querySelector("#ff-modal-title")?.textContent).toBe("切换到完全访问？");
    expect(overlay.querySelector("#ff-modal-message")?.textContent).toContain("git clone");
    expect(cancel.textContent).toBe("再想想");
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("我了解风险（5）");
    expect(api.setPermissionLevel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(confirm.textContent).toBe("我了解风险（4）");
    vi.advanceTimersByTime(3000);
    expect(confirm.textContent).toBe("我了解风险（1）");
    expect(confirm.disabled).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toBe("我了解风险，启用");

    confirm.click();
    await flush();
    expect(api.setPermissionLevel).toHaveBeenCalledWith("full");
    expect(overlay.classList.contains("is-hidden")).toBe(true);
    expect(button("full").classList.contains("is-active")).toBe(true);
  });

  it("cancels without changing the level and clears the countdown", async () => {
    vi.useFakeTimers();
    const { api, button, overlay, cancel, confirm } = await setup();

    button("full").click();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(confirm.textContent).toBe("我了解风险（4）");

    cancel.click();
    await flush();

    expect(api.setPermissionLevel).not.toHaveBeenCalled();
    expect(overlay.classList.contains("is-hidden")).toBe(true);
    expect(confirm.disabled).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(overlay.classList.contains("is-hidden")).toBe(true);
    expect(button("read-only").classList.contains("is-active")).toBe(true);
  });

  it("refuses full access when the shared modal overlay is unavailable", async () => {
    const { api, button } = await setup({ overlay: false });

    button("full").click();
    await flush();

    expect(modalMock.init).toHaveBeenCalled();
    expect(api.setPermissionLevel).not.toHaveBeenCalled();
  });
});
