import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import BoopiApp from "./BoopiApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BoopiApp />
  </StrictMode>,
);
