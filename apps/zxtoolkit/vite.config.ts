import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "zxtoolkit",
        short_name: "zxtoolkit",
        description: "把刚截的图，快速送到另一台设备。",
        theme_color: "#f3f1eb",
        background_color: "#f3f1eb",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
        ]
      }
    })
  ]
});