import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";

export default defineConfig({
	site: "https://zx-dx.xyz",
	integrations: [sitemap(), react()],
	vite: {
		resolve: {
			dedupe: ["react", "react-dom"],
		},
		build: {
			rollupOptions: {
				output: {
					// Strudel merges module exports into its evaluation scope at runtime.
					minifyInternalExports: false,
				},
			},
		},
	},
});
