import React from "react";
import ReactDOM from "react-dom/client";
import "@glideapps/glide-data-grid/dist/index.css";
import "./index.css";
import App from "./App";
import { applySettings, useSettings } from "./store/settings";

// The saved theme before the first paint (settings load synchronously from localStorage).
applySettings(useSettings.getState());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
