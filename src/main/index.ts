/** Route before normal identity, storage, plugins or lifecycle modules are loaded. */
import { app } from "electron";
import { dispatchMainEntry } from "./startup-entry";
dispatchMainEntry(app.commandLine.hasSwitch("firefly-memory-online-once"), {
  diagnostic: () => { void require("./memory-online-once/diagnostic-main").startDiagnosticMain(); },
  openrouter: () => { void require("./memory-openrouter-once/diagnostic-main").startOpenRouterDiagnosticMain(); },
  ordinary: () => { require("./application/normal-main"); },
}, app.commandLine.hasSwitch("firefly-memory-openrouter-once"));
