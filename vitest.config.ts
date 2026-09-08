import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // TypeScript sources are the test authority; dist contains compiled copies.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
