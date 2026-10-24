import { app } from "electron";
import { applyElectronPaths, resolveRuntimeProfile } from "./runtime-profile";
import { initializeStorageContext } from "./storage-context";

// Keep this import first in Main: CJS evaluates preflight before service imports.
export const runtimeProfile = resolveRuntimeProfile({
  argv: process.argv,
  env: process.env,
  isPackaged: app.isPackaged,
  productionAppData: app.getPath("appData"),
});
applyElectronPaths(app, runtimeProfile);
export const storageContext = initializeStorageContext(runtimeProfile);
export const userDataDir = storageContext.dataRoot;
