/** Route before normal identity, storage, plugins or lifecycle modules are loaded. */
import { app } from "electron";
import { dispatchMainEntry } from "./base/identity/startup-entry";
dispatchMainEntry(app.commandLine.hasSwitch("firefly-memory-online-once"), {
  diagnostic: () => { void require("./features/diagnostics/memory-online-once/diagnostic-main").startDiagnosticMain(); },
  openrouter: () => { void require("./features/diagnostics/memory-openrouter-once/diagnostic-main").startOpenRouterDiagnosticMain(); },
  ordinary: () => { require("./app/normal-main"); },
}, app.commandLine.hasSwitch("firefly-memory-openrouter-once"));
