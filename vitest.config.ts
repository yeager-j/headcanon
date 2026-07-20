import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@workspace/headcanon": `${import.meta.dirname}/src/index.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
