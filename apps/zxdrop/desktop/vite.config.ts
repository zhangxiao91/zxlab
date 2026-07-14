import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const appRoot = resolve(__dirname, "..");
  const env = loadEnv(mode, appRoot, "VITE_");
  return {
    root: __dirname,
    plugins: [react()],
    envDir: appRoot,
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(env.VITE_API_BASE_URL || "http://localhost:8787"),
      "import.meta.env.VITE_PUBLIC_APP_URL": JSON.stringify(env.VITE_PUBLIC_APP_URL || "http://localhost:4173")
    },
    server: { port: 4174, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true }
  };
});
