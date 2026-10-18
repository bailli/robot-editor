import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "tools", include: ["test/**/*.test.ts"] },
});
