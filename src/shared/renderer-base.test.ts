import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = import.meta.env as Record<string, unknown>;
const originalBaseUrl = env.BASE_URL;
const originalDocument = (globalThis as { document?: unknown }).document;

function installDocument(baseURI: string): void {
  (globalThis as { document?: unknown }).document = { baseURI };
}

async function load(baseUrl: string, baseURI: string) {
  env.BASE_URL = baseUrl;
  installDocument(baseURI);
  vi.resetModules();
  return import("./renderer-base");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  env.BASE_URL = originalBaseUrl;
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

describe("getRendererBase", () => {
  it("resolves the dev server root from an absolute Vite base", async () => {
    const { getRendererBase } = await load("/", "http://localhost:5173/chat/index.html");
    expect(getRendererBase()).toBe("http://localhost:5173/");
  });

  it("resolves the renderer directory for the root production window", async () => {
    const { getRendererBase } = await load("./", "file:///C:/Firefly/dist/renderer/index.html");
    expect(getRendererBase()).toBe("file:///C:/Firefly/dist/renderer/");
  });

  it.each(["react", "sidebar", "tasks", "settings", "call", "sticker-manager"])(
    "walks up one level from the %s sub-window in production",
    async (subdirectory) => {
      const { getRendererBase } = await load(
        "./",
        `file:///C:/Firefly/dist/renderer/${subdirectory}/index.html`,
      );
      expect(getRendererBase()).toBe("file:///C:/Firefly/dist/renderer/");
    },
  );

  it("does not walk up for an unknown sub-window", async () => {
    const { getRendererBase } = await load("./", "file:///C:/Firefly/dist/renderer/other/index.html");
    expect(getRendererBase()).toBe("file:///C:/Firefly/dist/renderer/other/");
  });

  it("does not walk up in dev mode even for a sub-window path", async () => {
    const { getRendererBase } = await load("/", "http://localhost:5173/react/index.html");
    expect(getRendererBase()).toBe("http://localhost:5173/");
  });

  it("computes the base once and caches it", async () => {
    const { getRendererBase } = await load("/", "http://localhost:5173/index.html");
    expect(getRendererBase()).toBe("http://localhost:5173/");
    installDocument("http://localhost:9999/elsewhere/index.html");
    expect(getRendererBase()).toBe("http://localhost:5173/");
  });
});

describe("resolveAsset", () => {
  it("joins a relative asset path to the renderer base", async () => {
    const { resolveAsset } = await load("/", "http://localhost:5173/index.html");
    expect(resolveAsset("models/firefly/Firefly.model3.json"))
      .toBe("http://localhost:5173/models/firefly/Firefly.model3.json");
  });

  it("strips one or more leading slashes", async () => {
    const { resolveAsset } = await load("/", "http://localhost:5173/index.html");
    expect(resolveAsset("/models/a.png")).toBe("http://localhost:5173/models/a.png");
    expect(resolveAsset("///models/a.png")).toBe("http://localhost:5173/models/a.png");
  });

  it("returns the bare base for an empty asset path", async () => {
    const { resolveAsset } = await load("./", "file:///C:/Firefly/dist/renderer/index.html");
    expect(resolveAsset("")).toBe("file:///C:/Firefly/dist/renderer/");
  });

  it("uses the same cached base as getRendererBase", async () => {
    const { getRendererBase, resolveAsset } = await load("/", "http://localhost:5173/index.html");
    expect(resolveAsset("x.png")).toBe(`${getRendererBase()}x.png`);
  });
});
