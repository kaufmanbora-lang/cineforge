import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/.next/**", "**/.desktop-runtime/**", "**/release/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/domain/**/*.ts", "src/server/movie/**/*.ts"],
    },
  },
});
