import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { BrowserRouter } from "react-router-dom";
import App from "./app/App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!convexUrl) {
  throw new Error("Missing VITE_CONVEX_URL. Run `npx convex dev` to connect this app.");
}

const convex = new ConvexReactClient(convexUrl);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider
      client={convex}
      replaceURL={(relativeUrl) => window.history.replaceState(null, "", relativeUrl)}
      shouldHandleCode={() => window.location.pathname !== "/reset-password"}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConvexAuthProvider>
  </React.StrictMode>,
);
