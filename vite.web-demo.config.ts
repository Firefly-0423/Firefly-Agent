import { defineConfig, type Plugin } from "vite";
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The online demo: the chat UI with in-page fake bridges (src/renderer/web-demo), for the promo site.
 * No public/ directory, so no Live2D model, Cubism core or sticker packs reach the web;
 * only the avatar the UI shows is copied next to the page, and partner portraits are swapped for a stub.
 */
const outDir = resolve(__dirname, process.env.FIREFLY_WEB_DEMO_OUT_DIR ?? "dist/site/demo");

function copyAvatars(): Plugin {
  return {
    name: "firefly-web-demo-avatars",
    closeBundle() {
      cpSync(resolve(__dirname, "src/renderer/public/avatars"), resolve(outDir, "web-demo/avatars"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyAvatars()],
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  publicDir: false,
  resolve: {
    // Partner portraits are other characters' artwork; the demo never shows a delegated partner, so none is published.
    alias: [{ find: /^.*\/character-portraits$/, replacement: resolve(__dirname, "src/renderer/web-demo/character-portraits.ts") }],
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: { "web-demo": resolve(__dirname, "src/renderer/web-demo/index.html") } },
  },
});
