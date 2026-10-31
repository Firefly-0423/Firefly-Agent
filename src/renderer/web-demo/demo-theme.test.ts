// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

describe("demo theme", () => {
  it("starts from the theme parameter and follows the host page's messages only", async () => {
    window.history.replaceState(null, "", "/demo/web-demo/?lang=zh&theme=dark");
    const { DEMO_THEME_MESSAGE, demoThemeFrom } = await import("./demo-theme");
    const api = window.fireflyTheme!;
    expect(await api.get()).toBe("firefly-dark");

    const seen = vi.fn();
    api.onChanged(seen);
    const send = (data: unknown, source: MessageEventSource | null = window.parent, origin = window.location.origin) =>
      window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
    send({ type: DEMO_THEME_MESSAGE, theme: "light" });
    expect(seen).toHaveBeenLastCalledWith("pearl-white");
    send({ type: DEMO_THEME_MESSAGE, theme: "dark" }, null);
    send({ type: DEMO_THEME_MESSAGE, theme: "dark" }, window.parent, "https://example.com");
    send({ type: "other", theme: "dark" });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(await api.get()).toBe("pearl-white");
    expect(demoThemeFrom("anything")).toBe("pearl-white");
  });
});
