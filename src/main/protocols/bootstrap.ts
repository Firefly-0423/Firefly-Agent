import { app, net, protocol } from "electron";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { getUiFontResponseHeaders, isSafeUiFontRequest } from "./ui-font-protocol";
import { getStickersDir } from "../stickers/sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "../stickers/sticker-protocol";

export function registerPrivilegedSchemes(): void {
  const stickerPrivileges = { standard: true, secure: true, supportFetchAPI: true, stream: true };
  const fontPrivileges = { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true };
  protocol.registerSchemesAsPrivileged([
    { scheme: "local-sticker", privileges: stickerPrivileges },
    { scheme: "local-font", privileges: fontPrivileges },
  ]);
}

function fetchLocalAsset(fileName: string): Promise<Response> {
  return net.fetch(pathToFileURL(fileName).toString());
}

function stickerResponse(request: Request): Response | Promise<Response> {
  const stickerName = parseLocalStickerFileFromUrl(request.url);
  if (!stickerName) return new Response("Invalid sticker URL", { status: 404 });
  const fileName = resolveLocalStickerPath(getStickersDir(), stickerName);
  if (!fileName) return new Response("Invalid sticker path", { status: 403 });
  return fetchLocalAsset(fileName);
}

function fontResponse(request: Request): Response | Promise<Response> {
  let fontName: string;
  try { fontName = decodeURIComponent(new URL(request.url).hostname); }
  catch { return new Response("Invalid font URL", { status: 404 }); }
  if (!isSafeUiFontRequest(fontName)) return new Response("Invalid font URL", { status: 404 });
  const directory = path.join(app.getPath("userData"), "ui-fonts");
  const fileName = path.join(directory, fontName);
  if (path.dirname(fileName) !== directory || !fs.existsSync(fileName)) {
    return new Response("Font not found", { status: 404 });
  }
  return fetchLocalAsset(fileName).then((response) => new Response(response.body, {
    headers: getUiFontResponseHeaders(fontName),
  }));
}

/** Call only after Electron is ready; privilege registration belongs before ready. */
export function registerProtocolHandlers(): void {
  protocol.handle("local-sticker", stickerResponse);
  protocol.handle("local-font", fontResponse);
}