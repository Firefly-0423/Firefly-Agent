import { defineConfig } from "vite";
import { resolve } from "node:path";
import { siteLicenses } from "./scripts/build/site-licenses.mjs";

/**
 * The promo site's landing page (site/). `npm run build:site` builds it first, then the demo into dist/site/demo.
 * Both builds write the licenses of what they bundle under licenses/; the site also carries the project's own notices.
 */
const outDir = resolve(__dirname, "dist/site");
export default defineConfig({
  root: resolve(__dirname, "site"),
  base: "./",
  publicDir: false,
  plugins: [siteLicenses({ outDir, title: "Firefly-Agent promo site", copy: [
    [resolve(__dirname, "LICENSE"), "licenses/LICENSE.txt"],
    [resolve(__dirname, "THIRD_PARTY_NOTICES.md"), "licenses/THIRD_PARTY_NOTICES.md"],
  ] })],
  build: {
    outDir,
    emptyOutDir: true,
  },
});
