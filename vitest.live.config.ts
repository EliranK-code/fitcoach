import { defineConfig } from "vitest/config";

// בדיקות מול Claude אמיתי. עולות כסף ודורשות ANTHROPIC_API_KEY ב-.env
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.live.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
