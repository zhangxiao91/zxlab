import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import PairApp from "./PairApp";
import InboxApp from "./InboxApp";
import PulseApp from "./PulseApp";
import "./styles.css";
import "./inbox.css";

registerSW({ immediate: true });

const pathname = window.location.pathname;
const RootApp = pathname.startsWith("/pair/") ? PairApp : pathname === "/inbox" ? InboxApp : pathname === "/pulse" || pathname === "/pulse/preview" ? PulseApp : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
