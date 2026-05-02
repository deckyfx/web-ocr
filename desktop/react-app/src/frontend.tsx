import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IPCReady, RustIPCProvider } from "@deckyfx/dioxus-react-bridge";
import "@deckyfx/dioxus-react-bridge/global";
import { App } from "./App";
import "./styles/globals.css";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <IPCReady
      fallback={
        <div className="flex h-screen items-center justify-center text-subtext0">
          Connecting to bridge…
        </div>
      }
    >
      <RustIPCProvider>
        <App />
      </RustIPCProvider>
    </IPCReady>
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
