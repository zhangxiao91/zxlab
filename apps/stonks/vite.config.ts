import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/lab/stonks/game/",
  plugins: [react()],
  build: {
    outDir: "../../public/lab/stonks/game",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  }
});
