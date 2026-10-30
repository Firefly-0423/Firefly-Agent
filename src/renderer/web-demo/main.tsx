import React from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "../react/App";
import { AppProviders } from "../react/app/providers/AppProviders";
import { initUiLocale } from "../react/i18n";
import { installDemoBridges } from "./demo-bridges";

const lang = new URLSearchParams(window.location.search).get("lang") === "en" ? "en" : "zh";
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
installDemoBridges(lang);

const host = document.getElementById("firefly-react-root");
if (!host) throw new Error("Root element #firefly-react-root not found");
const root = createRoot(host);
void initUiLocale().finally(() => {
  root.render(<React.StrictMode><AppProviders><App /></AppProviders></React.StrictMode>);
});
