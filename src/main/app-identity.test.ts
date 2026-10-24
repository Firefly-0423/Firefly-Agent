import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  FIREFLY_APPLICATION_NAME,
  FIREFLY_USER_DATA_DIRECTORY,
  configureFireflyApplicationIdentity,
} from "./app-identity";

describe("Firefly application identity", () => {
  it("binds the Firefly-based build to an independent userData directory before startup", () => {
    const setName = vi.fn();
    const setPath = vi.fn();
    const appData = path.join("C:\\Users", "tester", "AppData", "Roaming");

    const userDataPath = configureFireflyApplicationIdentity({
      getPath: (name) => {
        expect(name).toBe("appData");
        return appData;
      },
      setName,
      setPath,
    });

    expect(FIREFLY_APPLICATION_NAME).toBe("Firefly");
    expect(FIREFLY_USER_DATA_DIRECTORY).toBe("Firefly");
    expect(userDataPath).toBe(path.join(appData, FIREFLY_USER_DATA_DIRECTORY));
    expect(setName).toHaveBeenCalledWith(FIREFLY_APPLICATION_NAME);
    expect(setPath).toHaveBeenCalledWith("userData", userDataPath);
    expect(setPath).not.toHaveBeenCalledWith("appData", expect.any(String));
    expect(userDataPath.toLowerCase()).not.toContain("firefly-agent");
  });

  it("uses an explicit isolated appData root before assigning userData", () => {
    const appData = path.join(os.tmpdir(), "firefly-real-app-data");
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-isolated-app-data-"));
    let currentAppData = appData;
    const paths = new Map<string, string>();
    const setPath = vi.fn((name: string, value: string) => {
      paths.set(name, value);
      if (name === "appData") currentAppData = value;
    });

    const userDataPath = configureFireflyApplicationIdentity({
      getPath: (name) => name === "appData" ? currentAppData : paths.get(name) ?? "",
      setName: vi.fn(),
      setPath,
    }, isolatedRoot);

    expect(userDataPath).toBe(path.join(isolatedRoot, "Firefly"));
    expect(setPath.mock.calls).toEqual([
      ["appData", isolatedRoot],
      ["userData", userDataPath],
      ["sessionData", userDataPath],
    ]);
    expect(fs.statSync(userDataPath).isDirectory()).toBe(true);
  });

  it("aborts isolated startup when Electron does not retain an isolated sessionData path", () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-isolated-app-data-"));
    const ordinaryAppData = path.join(os.tmpdir(), "firefly-real-app-data");
    const paths = new Map<string, string>();

    expect(() => configureFireflyApplicationIdentity({
      getPath: (name) => name === "appData" ? paths.get(name) ?? ordinaryAppData
        : name === "sessionData" ? ordinaryAppData : paths.get(name) ?? "",
      setName: vi.fn(),
      setPath: (name, value) => { paths.set(name, value); },
    }, isolatedRoot)).toThrow("FIREFLY_ISOLATED_SESSION_DATA_FAILED");
  });

  it("rejects a non-absolute isolated root without assigning userData", () => {
    const setPath = vi.fn();
    expect(() => configureFireflyApplicationIdentity({
      getPath: () => path.join(os.tmpdir(), "firefly-real-app-data"),
      setName: vi.fn(),
      setPath,
    }, "relative-smoke-data")).toThrow("FIREFLY_ISOLATED_APPDATA_INVALID");
    expect(setPath).not.toHaveBeenCalled();
  });

  it("rejects an isolated root inside the ordinary appData directory", () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-real-app-data-"));
    const nested = path.join(appData, "smoke");
    fs.mkdirSync(nested);
    const setPath = vi.fn();

    expect(() => configureFireflyApplicationIdentity({
      getPath: () => appData,
      setName: vi.fn(),
      setPath,
    }, nested)).toThrow("FIREFLY_ISOLATED_APPDATA_INVALID");
    expect(setPath).not.toHaveBeenCalled();
  });

});

it("captures existing appData metadata without applying identity or creating source paths",async()=>{
 const identity=await import("./app-identity");
 const calls:string[]=[];
 expect(identity.getFireflyApplicationDataPath({getPath(name){calls.push(name);return "E:/synthetic-source";}})).toBe("E:/synthetic-source");
 expect(calls).toEqual(["appData"]);
});
