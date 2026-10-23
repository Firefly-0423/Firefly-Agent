import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";

export const PET_WINDOW_BASE_WIDTH = 400;
export const PET_WINDOW_BASE_HEIGHT = 500;
export type PetWindowSettingsSlice = { petZoom?: number; petWindowY?: number; petWindowX?: number };
export type CreatePetWindowContext = {
  isDev: boolean;
  loadGeneralSettings: () => PetWindowSettingsSlice;
  getCurrentAppIconPath: () => string;
};
export type CreatePetWindowOptions = { showOnReady?: boolean };

function placePet(preferences: PetWindowSettingsSlice, extentX: number, extentY: number): { x: number; y: number } {
  if (preferences.petWindowX !== undefined && preferences.petWindowY !== undefined) {
    const bounds = { x: preferences.petWindowX, y: preferences.petWindowY, width: extentX, height: extentY };
    const work = screen.getDisplayMatching(bounds).workArea;
    const overlapX = Math.min(bounds.x + extentX, work.x + work.width) - Math.max(bounds.x, work.x);
    const overlapY = Math.min(bounds.y + extentY, work.y + work.height) - Math.max(bounds.y, work.y);
    if (overlapX >= extentX / 3 && overlapY >= extentY / 3) {
      return { x: preferences.petWindowX, y: preferences.petWindowY };
    }
    console.log("[Firefly] 桌宠保存位置已离屏（仅 " + overlapX + "x" + overlapY + " 可见），回退到屏幕中央");
  }
  const work = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(work.x + (work.width - extentX) / 2), y: Math.round(work.y + (work.height - extentY) / 2) };
}

export function createPetWindow(environment: CreatePetWindowContext, appearance: CreatePetWindowOptions = {}): BrowserWindow {
  const { showOnReady: reveal = true } = appearance;
  const preferences = environment.loadGeneralSettings();
  const scale = typeof preferences.petZoom === "number" && preferences.petZoom > 0 ? preferences.petZoom : 1;
  const extentX = Math.round(PET_WINDOW_BASE_WIDTH * scale);
  const extentY = Math.round(PET_WINDOW_BASE_HEIGHT * scale);
  const coordinates = placePet(preferences, extentX, extentY);
  const pet = new BrowserWindow({
    x: coordinates.x, y: coordinates.y, width: extentX, height: extentY,
    transparent: true, frame: false, skipTaskbar: true, focusable: false,
    resizable: false, hasShadow: false, show: false,
    icon: environment.getCurrentAppIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  if (environment.isDev) pet.loadURL("http://localhost:5173");
  else pet.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  if (!environment.isDev) pet.setIgnoreMouseEvents(true, { forward: true });

  const sendVisibility = (visible: boolean): void => { pet.webContents.send(IPC.PET_VISIBILITY_CHANGED, visible); };
  pet.on("hide", () => sendVisibility(false));
  pet.on("show", () => sendVisibility(true));
  pet.once("ready-to-show", () => {
    if (reveal && !pet.isDestroyed()) pet.show();
  });
  return pet;
}
