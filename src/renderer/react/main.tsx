import React from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "./App";
import { AppProviders } from "./app/providers/AppProviders";
import { initUiLocale } from "./i18n";

function requireMountPoint(): HTMLElement {
  const mountPoint = document.getElementById("firefly-react-root");
  if (mountPoint) return mountPoint;
  throw new Error("Root element #firefly-react-root not found");
}

const reactRoot = createRoot(requireMountPoint());
void initUiLocale().finally(() => {
  const application = React.createElement(AppProviders, null, React.createElement(App));
  reactRoot.render(React.createElement(React.StrictMode, null, application));
});
