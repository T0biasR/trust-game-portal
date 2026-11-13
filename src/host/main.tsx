import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { App } from "../portal/App";
import { initializeHostedRuntime, type HostConfig } from "./runtime";

declare global {
  interface Window {
    __STUDY_HOST_CONFIG__?: HostConfig;
  }
}

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app");

const config = window.__STUDY_HOST_CONFIG__;
if (!config) throw new Error("Missing hosted study configuration");

void initializeHostedRuntime(config).then(() => {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
