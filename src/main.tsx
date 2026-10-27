import React from "react";
import ReactDOM from "react-dom/client";
import "@glideapps/glide-data-grid/dist/index.css";
import "./index.css";
import App from "./App";
import { moveLegacyCopies, setVaultUnavailableHandler } from "./lib/vaultStorage";
import { applySettings, useSettings } from "./store/settings";
import { toast } from "./store/toasts";

// The saved theme before the first paint (settings load synchronously from localStorage).
applySettings(useSettings.getState());
setVaultUnavailableHandler((message) => toast(message, "error"));
void moveLegacyCopies();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
