import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          S3_PUBLIC_ENDPOINT: "https://media.example.test",
          BACK_URL: "https://api.example.test",
          ALLOWED_ORIGINS: "https://front.example.test, http://localhost:3000",
        },
      },
    }),
  ],
});
