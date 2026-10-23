// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const getGeneral = vi.fn(), saveGeneral = vi.fn();
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); getGeneral.mockReset().mockResolvedValue({}); saveGeneral.mockReset().mockResolvedValue(undefined); Object.assign(window, { settings: { getGeneral, saveGeneral } }); document.body.innerHTML = '<input type="checkbox" id="plugin-email-enabled"><div id="plugin-email-config"></div>' + ["host", "port", "user", "pass"].map(f => `<input id="email-smtp-${f}">`).join("") + '<input type="checkbox" id="email-smtp-secure"><input id="email-from-name">'; vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); delete (window as any).settings; });
it("loads default values and hides disabled configuration", async () => { await import("./panel"); await Promise.resolve(); expect(input("email-smtp-port").value).toBe("465"); expect(input("email-smtp-host").value).toBe(""); expect(input("plugin-email-enabled").checked).toBe(false); expect(document.getElementById("plugin-email-config")?.style.display).toBe("none"); });
it("loads all configured values and shows enabled fields", async () => {
  getGeneral.mockResolvedValue({ emailEnabled: true, emailSmtpHost: "smtp", emailSmtpPort: 587, emailSmtpSecure: true, emailSmtpUser: "user", emailSmtpPass: "pass", emailFromName: "name" }); const api = await import("./panel"); await api.loadEmailConfig(); expect(input("plugin-email-enabled").checked).toBe(true); expect(input("email-smtp-secure").checked).toBe(true); expect(["host", "port", "user", "pass"].map(f => input(`email-smtp-${f}`).value)).toEqual(["smtp", "587", "user", "pass"]); expect(input("email-from-name").value).toBe("name"); expect(document.getElementById("plugin-email-config")?.style.display).toBe("block");
});
it("saves enablement/security immediately and updates visibility", async () => {
  await import("./panel"); await Promise.resolve(); input("plugin-email-enabled").checked = true; input("plugin-email-enabled").dispatchEvent(new Event("change")); input("email-smtp-secure").checked = true; input("email-smtp-secure").dispatchEvent(new Event("change")); expect(saveGeneral.mock.calls).toEqual([[{ emailEnabled: true }], [{ emailSmtpSecure: true }]]); expect(document.getElementById("plugin-email-config")?.style.display).toBe("block");
});
it("debounces each text field independently with trimmed values", async () => {
  await import("./panel"); for (const [id, value] of [["email-smtp-host", " old "], ["email-smtp-user", " user "], ["email-smtp-pass", " pass "], ["email-from-name", " name "]]) { input(id).value = value; input(id).dispatchEvent(new Event("input")); }
  await vi.advanceTimersByTimeAsync(400); input("email-smtp-host").value = " final "; input("email-smtp-host").dispatchEvent(new Event("input")); await vi.advanceTimersByTimeAsync(400); expect(saveGeneral.mock.calls).toEqual([[{ emailSmtpUser: "user" }], [{ emailSmtpPass: "pass" }], [{ emailFromName: "name" }]]); await vi.advanceTimersByTimeAsync(400); expect(saveGeneral).toHaveBeenLastCalledWith({ emailSmtpHost: "final" });
});
it.each([["0", 465], ["bad", 465], ["587", 587]])("normalizes port %s to %s", async (value, port) => { await import("./panel"); input("email-smtp-port").value = value; input("email-smtp-port").dispatchEvent(new Event("input")); await vi.advanceTimersByTimeAsync(800); expect(saveGeneral).toHaveBeenCalledWith({ emailSmtpPort: port }); });
it("contains bridge failures and supports absent bridge or optional DOM", async () => {
  const api = await import("./panel"); getGeneral.mockRejectedValue(Error("offline")); await expect(api.loadEmailConfig()).resolves.toBeUndefined(); saveGeneral.mockRejectedValue(Error("offline")); await expect(api.saveEmailField("emailEnabled", true)).resolves.toBeUndefined(); delete (window as any).settings; await expect(api.saveEmailField("emailEnabled", true)).resolves.toBeUndefined(); document.body.innerHTML = ""; vi.resetModules(); await import("./panel");
});
