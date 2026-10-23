import path from "node:path";
import { expect, it } from "vitest";
import { build } from "vite";
it("emits the AudioWorklet as a same-origin asset allowed by the unchanged script-src self CSP", async () => {
  const result=await build({ configFile:false, root:process.cwd(),publicDir:false,logLevel:"silent",build:{write:false,rollupOptions:{input:path.resolve("src/renderer/react/features/chat/components/desktop-asr-audio.ts"),preserveEntrySignatures:"strict"}} });
  const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>"output" in item?item.output:[]);
  expect(outputs.some(item=>item.type==="asset" && /desktop-asr-worklet.*\.js$/.test(item.fileName))).toBe(true);
  const chunks=outputs.filter(item=>item.type==="chunk").map(item=>item.code).join("\n");
  expect(chunks).not.toContain("data:text/javascript");
});
