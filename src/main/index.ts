/** Route before normal identity, storage, plugins or lifecycle modules are loaded. */
import { app } from "electron";
import { diagnosticSwitchesAllowed, dispatchMainEntry } from "./base/identity/startup-entry";
import { logger, LogTag } from "../shared/logger";
dispatchMainEntry(app.commandLine.hasSwitch("firefly-memory-online-once"), {
  diagnostic: () => { void require("./features/diagnostics/memory-online-once/diagnostic-main").startDiagnosticMain(); },
  openrouter: () => { void require("./features/diagnostics/memory-openrouter-once/diagnostic-main").startOpenRouterDiagnosticMain(); },
  ordinary: () => { require("./app/normal-main"); },
  ignored: () => { logger.warn(LogTag.Runtime, "diagnostic startup switches are ignored in installed builds"); },
}, app.commandLine.hasSwitch("firefly-memory-openrouter-once"), diagnosticSwitchesAllowed(app.isPackaged));
