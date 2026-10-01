import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: "forks",
    server: {
      deps: {
        // node:sqlite is experimental; keep Node builtins external to Vite transform
        external: [/^node:/],
      },
    },
  },
});
