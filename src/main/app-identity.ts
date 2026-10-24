import * as fs from "node:fs";
import * as path from "node:path";

/** Stable Firefly application and user-data identities. */
export const FIREFLY_APPLICATION_NAME = "Firefly";
export const FIREFLY_USER_DATA_DIRECTORY = "Firefly";

export interface FireflyIdentityApp {
  getPath(name: "appData" | "userData" | "sessionData"): string;
  setName(name: string): void;
  setPath(name: "userData" | "appData" | "sessionData", value: string): void;
}

/** Read-only metadata capture, shared by ordinary and restricted startup. */
export function getFireflyApplicationDataPath(app:Pick<FireflyIdentityApp,"getPath">):string {
  return app.getPath("appData");
}

/**
 * Must run before the single-instance lock and before any settings store is
 * constructed. The user-data directory is independent of the technical npm
 * package name and the packaged product display name.
 */
export function configureFireflyApplicationIdentity(app: FireflyIdentityApp, isolatedAppData?: string): string {
  let isolatedRoot: string | undefined;
  if (isolatedAppData !== undefined) {
    let root: string;
    try {
      if (!path.isAbsolute(isolatedAppData)) throw new Error("invalid root");
      root = fs.realpathSync(isolatedAppData);
      isolatedRoot = root;
      if (!fs.statSync(root).isDirectory()) throw new Error("invalid directory");
      const existingAppData = path.resolve(app.getPath("appData"));
      const insideExisting = path.relative(existingAppData, root);
      const containsExisting = path.relative(root, existingAppData);
      if ([insideExisting, containsExisting].some((relative) => relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))) {
        throw new Error("overlapping app data");
      }
    } catch {
      throw new Error("FIREFLY_ISOLATED_APPDATA_INVALID");
    }
    app.setPath("appData", root);
    if (path.resolve(app.getPath("appData")) !== root) throw new Error("FIREFLY_ISOLATED_APPDATA_FAILED");
  }
  const userDataPath = path.join(getFireflyApplicationDataPath(app), FIREFLY_USER_DATA_DIRECTORY);
  if (isolatedRoot !== undefined) fs.mkdirSync(userDataPath, { recursive: true });
  app.setName(FIREFLY_APPLICATION_NAME);
  app.setPath("userData", userDataPath);
  if (isolatedRoot !== undefined) {
    app.setPath("sessionData", userDataPath);
    const paths = {
      appData: path.resolve(app.getPath("appData")),
      userData: path.resolve(app.getPath("userData")),
      sessionData: path.resolve(app.getPath("sessionData")),
    };
    if (paths.appData !== isolatedRoot) throw new Error("FIREFLY_ISOLATED_APPDATA_FAILED");
    if (paths.userData !== userDataPath) throw new Error("FIREFLY_ISOLATED_USER_DATA_FAILED");
    if (paths.sessionData !== userDataPath) throw new Error("FIREFLY_ISOLATED_SESSION_DATA_FAILED");
    console.info("[Firefly isolated paths]", paths);
  }
  return userDataPath;
}
