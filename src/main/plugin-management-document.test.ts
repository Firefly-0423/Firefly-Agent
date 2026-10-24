import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { isFromHostDocument } from "./plugin-host/plugin-management-ipc-guard";

vi.mock("./env", () => ({ isDev: false }));
vi.mock("electron", () => ({ app: { getAppPath: () => process.cwd() } }));

it("accepts only the packaged document at the application root", () => {
  const expected = pathToFileURL(path.join(process.cwd(), "dist/renderer/settings/index.html")).href;
  const mainFrame = { url: `${expected}#plugins` };
  const host = { isDestroyed: () => false, mainFrame };
  const event = { sender: host, senderFrame: mainFrame };
  expect(isFromHostDocument(event as never, host as never, "settings")).toBe(true);
  for (const url of [expected + "?other=1", expected.replace("/settings/", "/react/"), expected + "/evil", "http://localhost:5173/settings/"]) {
    mainFrame.url = url;
    expect(isFromHostDocument(event as never, host as never, "settings")).toBe(false);
  }
});
