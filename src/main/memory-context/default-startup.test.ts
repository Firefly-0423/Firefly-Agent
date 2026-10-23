import fs from "node:fs";
import { expect, it } from "vitest";
// Composition checks complement the real SQLite/runtime tests in main-default-memory.test.ts.
const application=fs.readFileSync(new URL("../application/default-dependencies.ts",import.meta.url),"utf8");
it("normal startup constructs the ordinary owner and passes it to the actual runtime",()=>{
 expect(application).toContain("createMainDefaultMemory");
 expect(application).toMatch(/defaultMemory\s*=\s*memoryEnabled\s*\?\s*null\s*:\s*createMainDefaultMemory/);
 expect(application).toContain("defaultMemory:defaultMemory");
 expect(application).toContain("host:defaultMemory?.settingsHost");
});
it("ordinary composition disables legacy personal-memory services without dropping documents",()=>{
 expect(application).toContain('personalMemoryMode:defaultMemory?"smh":"legacy"');
 expect(application).toContain('if (signal.aborted || defaultMemory) return;');
 expect(application).toContain('reconcileUserMemoryIndex:defaultMemory?async()=>{}:reconcileUserMemoryIndex');
 expect(application).toContain("defaultMemory?.refreshModels()");
});

it("ordinary channel startup receives the same default memory owner",()=>{
 expect(application).toMatch(/createChannelsSubsystem\(\{[\s\S]*?memory:defaultMemory\?\.channelHost/);
});
it("ordinary background producers share the owner and drain proactive generation at shutdown",()=>{
 expect(application).toContain('createProactiveLifecycle({ loadGeneralSettings, memoryHost:defaultMemory?.backgroundHost })');
 expect(application).toMatch(/createSchedulerSubsystem\(\{[\s\S]*?memoryHost:defaultMemory\?\.backgroundHost/);
 expect(application).toContain('dispose: () => core.services.proactive.close()');
});
it("ordinary memory capture reads the actual installed Harness run evidence on recovery",()=>{
 expect(application).toContain('runReader:{get:runId=>getHarnessRunStore(getStorageContext().dataRoot).get(runId)}');
});
