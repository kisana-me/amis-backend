import { defineConfig } from "drizzle-kit";

// 生成だけに使う。適用は wrangler d1 migrations apply で行う
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
});
