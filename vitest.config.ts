import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["**/*.live.test.ts", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // מפתח בדיקה בלבד, לא לשימוש אמיתי
      MASTER_ENCRYPTION_KEY: "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMzJieXQ=",
      LOG_LEVEL: "silent",
      // As shipped: no local-number country code, whatever the developer's .env says (tests pass one explicitly).
      DEFAULT_COUNTRY_CODE: "",
    },
  },
});
