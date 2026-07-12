import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "worker/.wrangler/**", "worker/worker-configuration.d.ts"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "worker/src/**/*.ts", "vite.config.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]
    }
  }
);
