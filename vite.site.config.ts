import { defineConfig } from "vite";
import { resolve } from "node:path";

/** The promo site's landing page (site/). `npm run build:site` builds it first, then the demo into dist/site/demo. */
export default defineConfig({
  root: resolve(__dirname, "site"),
  base: "./",
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist/site"),
    emptyOutDir: true,
  },
});
