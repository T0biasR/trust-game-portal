import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./portal/App";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
