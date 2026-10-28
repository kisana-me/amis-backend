import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // テストごとのローカル D1 に、本物と同じマイグレーションを当てる (test/setup.ts)
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            S3_PUBLIC_ENDPOINT: "https://media.example.test",
            BACK_URL: "https://api.example.test",
            ALLOWED_ORIGINS: "https://front.example.test, http://localhost:3000",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
