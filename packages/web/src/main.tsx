import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { applyColorScheme, getStoredColorScheme } from "@/lib/preferences";

// Apply dark mode from system preference or stored preference
function initTheme() {
  applyColorScheme(getStoredColorScheme());
}
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
